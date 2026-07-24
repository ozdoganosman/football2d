import { F_PLAYERS, FRAME_STRIDE, HALF_LENGTH, HALF_WIDTH } from '../engine/constants'
import { playerInfoAt } from '../engine/roster'
import type { MatchResult } from '../engine/types'
import { computeCam, drawPitch, wx, wy, type Cam } from './pitch'

// Maç-sonu analiz görselleri: ısı haritası ve pas ağı. Kare verisinden
// (tüm oyuncu pozisyonları) ve olaylardan (paslar) türetilir; canlı oynatmadan
// bağımsız kendi tuvaline çizilir.

const onPitch = (x: number, y: number): boolean =>
  Math.abs(x) <= HALF_LENGTH && Math.abs(y) <= HALF_WIDTH

// Kare örnekleme adımı (performans): ~1500 kare üzerinden istatistik yeterli
function sampleStep(frameCount: number): number {
  return Math.max(1, Math.floor(frameCount / 1500))
}

// Devre arası saha değişimi: takımlar ikinci yarıda kaleleri değiştirir. Ham
// pozisyonların maç boyu ortalaması merkeze düşer (H1/H2 birbirini götürür).
// Bu yüzden pozisyonları takımın DAİMA +x'e hücum ettiği "hücum çerçevesine"
// döndürürüz. İlk yarı hücum yönü: ev +x (1), deplasman -x (-1).
const ATTACK_H1 = [1, -1]

function halfBoundaryTick(events: { tick: number; kind: string }[], frameCount: number): number {
  for (const e of events) if (e.kind === 'half_end') return e.tick
  return Math.floor(frameCount / 2)
}

// Bir karede takımın hücum çerçevesine göre işaret (H2'de ters)
function attackSign(team: number, tick: number, halfTick: number): number {
  return ATTACK_H1[team] * (tick < halfTick ? 1 : -1)
}

// Isı haritası: bir takımın tüm kare pozisyonlarını ızgaraya döker, yoğunluğu
// mavi→sarı→kırmızı bir rampayla, saha üzerinde yarı saydam çizer.
export function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  cam: Cam,
  result: MatchResult,
  team: number,
): void {
  const COLS = 42
  const ROWS = 28
  const grid = new Float32Array(COLS * ROWS)
  const { frames, frameCount } = result
  const step = sampleStep(frameCount)
  const halfTick = halfBoundaryTick(result.events, frameCount)
  let maxV = 0
  for (let k = 0; k < frameCount; k += step) {
    const base = k * FRAME_STRIDE
    const s = attackSign(team, k, halfTick)
    for (let p = 0; p < 11; p++) {
      const id = team * 11 + p
      const rx = frames[base + F_PLAYERS + id * 2]
      const ry = frames[base + F_PLAYERS + id * 2 + 1]
      if (!onPitch(rx, ry)) continue
      const x = rx * s
      const y = ry * s
      const cx = Math.min(COLS - 1, Math.floor(((x + HALF_LENGTH) / (2 * HALF_LENGTH)) * COLS))
      const cy = Math.min(ROWS - 1, Math.floor(((y + HALF_WIDTH) / (2 * HALF_WIDTH)) * ROWS))
      const gi = cy * COLS + cx
      grid[gi]++
      if (grid[gi] > maxV) maxV = grid[gi]
    }
  }
  const cellW = (2 * HALF_LENGTH) / COLS
  const cellH = (2 * HALF_WIDTH) / ROWS
  ctx.save()
  // Hafif bulanıklık daha yumuşak bir ısı görünümü verir (destekleniyorsa)
  ctx.filter = `blur(${Math.max(1, cam.scale * 0.6)}px)`
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const v = grid[cy * COLS + cx] / (maxV || 1)
      if (v < 0.03) continue
      const x0 = -HALF_LENGTH + cx * cellW
      const y0 = -HALF_WIDTH + cy * cellH
      ctx.fillStyle = heatColor(v)
      ctx.fillRect(wx(cam, x0), wy(cam, y0), cellW * cam.scale + 1.5, cellH * cam.scale + 1.5)
    }
  }
  ctx.restore()
}

// Yoğunluk → renk: 0 saydam mavi, .5 sarı, 1 kırmızı. Alfa yoğunlukla artar.
function heatColor(v: number): string {
  const a = 0.15 + 0.6 * v
  let r: number
  let g: number
  let b: number
  if (v < 0.5) {
    const t = v / 0.5
    r = Math.round(40 + t * 215)
    g = Math.round(120 + t * 135)
    b = Math.round(230 - t * 210)
  } else {
    const t = (v - 0.5) / 0.5
    r = 255
    g = Math.round(255 - t * 200)
    b = Math.round(20 - t * 20)
  }
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

// Pas ağı: düğümler oyuncuların ortalama konumu (kare verisinden), kenarlar
// aralarındaki pas sayısı (olaylardan). Düğüm boyu pas hacmine, kenar kalınlığı
// çift arası pas sıklığına orantılı.
export function drawPassNetwork(
  ctx: CanvasRenderingContext2D,
  cam: Cam,
  result: MatchResult,
  team: number,
): void {
  const { frames, frameCount, events } = result
  const sumX = new Float64Array(11)
  const sumY = new Float64Array(11)
  const cnt = new Float64Array(11)
  const step = sampleStep(frameCount)
  const halfTick = halfBoundaryTick(events, frameCount)
  for (let k = 0; k < frameCount; k += step) {
    const base = k * FRAME_STRIDE
    const s = attackSign(team, k, halfTick)
    for (let p = 0; p < 11; p++) {
      const id = team * 11 + p
      const rx = frames[base + F_PLAYERS + id * 2]
      const ry = frames[base + F_PLAYERS + id * 2 + 1]
      if (!onPitch(rx, ry)) continue
      sumX[p] += rx * s
      sumY[p] += ry * s
      cnt[p]++
    }
  }
  const posX = (p: number): number => sumX[p] / (cnt[p] || 1)
  const posY = (p: number): number => sumY[p] / (cnt[p] || 1)

  const edge = new Map<string, number>()
  const passVol = new Float64Array(11)
  for (const e of events) {
    if (e.kind !== 'pass' || e.teamIdx !== team) continue
    const a = e.playerId - team * 11
    const b = e.targetId - team * 11
    if (a < 0 || a > 10 || b < 0 || b > 10) continue
    passVol[a]++
    passVol[b]++
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    edge.set(key, (edge.get(key) ?? 0) + 1)
  }

  let maxE = 1
  for (const v of edge.values()) maxE = Math.max(maxE, v)
  for (const [key, v] of edge) {
    const [a, b] = key.split('-').map(Number)
    if (cnt[a] === 0 || cnt[b] === 0) continue
    const w = v / maxE
    ctx.beginPath()
    ctx.moveTo(wx(cam, posX(a)), wy(cam, posY(a)))
    ctx.lineTo(wx(cam, posX(b)), wy(cam, posY(b)))
    ctx.strokeStyle = `rgba(255,240,180,${(0.08 + 0.55 * w).toFixed(3)})`
    ctx.lineWidth = Math.max(1, cam.scale * 0.1 * (0.5 + 3 * w))
    ctx.stroke()
  }

  let maxV = 1
  for (const v of passVol) maxV = Math.max(maxV, v)
  const color = result.teams[team].color
  for (let p = 0; p < 11; p++) {
    if (cnt[p] === 0) continue
    const x = wx(cam, posX(p))
    const y = wy(cam, posY(p))
    const r = cam.scale * (0.9 + 1.7 * (passVol[p] / maxV))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(1, cam.scale * 0.2)
    ctx.stroke()
    const info = playerInfoAt(result.teams, result.substitutions, team * 11 + p, frameCount - 1)
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.max(7, cam.scale * 1.0)}px Verdana, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(info?.number ?? ''), x, y + 0.5)
  }
}

export type AnalyticsView = 'heat' | 'passes'

// Analiz tuvalini komple çizer: saha + seçilen görsel.
export function renderAnalytics(
  canvas: HTMLCanvasElement,
  result: MatchResult,
  view: AnalyticsView,
  team: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const cam: Cam = computeCam(w, h)
  ctx.clearRect(0, 0, w, h)
  drawPitch(ctx, cam, w, h, result.teams)
  if (view === 'heat') drawHeatmap(ctx, cam, result, team)
  else drawPassNetwork(ctx, cam, result, team)
}
