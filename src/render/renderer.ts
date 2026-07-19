import {
  F_BALL_X,
  F_BALL_Y,
  F_LABEL,
  F_PLAYERS,
  F_REF_X,
  F_REF_Y,
  FRAME_STRIDE,
  HALF_LENGTH,
  HALF_WIDTH,
} from '../engine/constants'
import type { MatchResult } from '../engine/types'
import { computeCam, drawPitch, wx, wy, type Cam } from './pitch'

// Kayıtlı kareleri çizen katman. Statik saha offscreen canvas'ta tutulur,
// her karede yalnızca oyuncular/top/hakemler çizilir.
export class Renderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private pitchLayer: HTMLCanvasElement
  private cam: Cam = { scale: 6, ox: 0, oy: 0 }
  private result: MatchResult
  private w = 0
  private h = 0

  constructor(canvas: HTMLCanvasElement, result: MatchResult) {
    this.canvas = canvas
    this.result = result
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context alınamadı')
    this.ctx = ctx
    this.pitchLayer = document.createElement('canvas')
    this.resize()
  }

  setResult(result: MatchResult): void {
    this.result = result
    this.redrawPitch()
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.w = Math.max(100, Math.round(rect.width * dpr))
    this.h = Math.max(100, Math.round(rect.height * dpr))
    this.canvas.width = this.w
    this.canvas.height = this.h
    this.cam = computeCam(this.w, this.h)
    this.redrawPitch()
  }

  private redrawPitch(): void {
    this.pitchLayer.width = this.w
    this.pitchLayer.height = this.h
    const pctx = this.pitchLayer.getContext('2d')
    if (pctx) drawPitch(pctx, this.cam, this.w, this.h, this.result.teams)
  }

  private fv(frame: number, off: number): number {
    return this.result.frames[frame * FRAME_STRIDE + off]
  }

  private lerpVal(f0: number, f1: number, off: number, a: number): number {
    return this.fv(f0, off) * (1 - a) + this.fv(f1, off) * a
  }

  // playhead: kesirli kare indeksi
  draw(playhead: number): void {
    const { ctx, result } = this
    const f0 = Math.floor(playhead)
    const f1 = Math.min(result.frameCount - 1, f0 + 1)
    const a = playhead - f0

    ctx.drawImage(this.pitchLayer, 0, 0)

    // Yan hakemler (top x'ini izler, her biri bir yarıyı gezer)
    const ballX = this.lerpVal(f0, f1, F_BALL_X, a)
    const ballY = this.lerpVal(f0, f1, F_BALL_Y, a)
    this.drawDot(Math.max(-HALF_LENGTH, Math.min(0, ballX)), -HALF_WIDTH - 1.6, '#1a1a1a', 0.85)
    this.drawDot(Math.max(0, Math.min(HALF_LENGTH, ballX)), HALF_WIDTH + 1.6, '#1a1a1a', 0.85)

    // Hakem
    const refX = this.lerpVal(f0, f1, F_REF_X, a)
    const refY = this.lerpVal(f0, f1, F_REF_Y, a)
    this.drawDot(refX, refY, '#1a1a1a', 1.0, 'R')

    // Oyuncular
    const labelIdx = this.fv(f0, F_LABEL)
    for (let i = 0; i < 22; i++) {
      const px = this.lerpVal(f0, f1, F_PLAYERS + i * 2, a)
      const py = this.lerpVal(f0, f1, F_PLAYERS + i * 2 + 1, a)
      const teamIdx = i < 11 ? 0 : 1
      const team = result.teams[teamIdx]
      const isGk = i % 11 === 0
      const info = team.starters[i % 11]
      this.drawPlayer(px, py, isGk ? team.gkColor : team.color, info.number)
      if (i === labelIdx) this.drawLabel(px, py, info.name)
    }

    // Top
    this.drawBall(ballX, ballY, labelIdx)
  }

  private drawPlayer(x: number, y: number, color: string, num: number): void {
    const { ctx, cam } = this
    const r = cam.scale * 1.25
    const cx = wx(cam, x)
    const cy = wy(cam, y)
    ctx.beginPath()
    ctx.arc(cx, cy + r * 0.25, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(1, cam.scale * 0.22)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.max(7, cam.scale * 1.3)}px Verdana, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(num), cx, cy + cam.scale * 0.1)
  }

  private drawDot(x: number, y: number, color: string, r: number, text?: string): void {
    const { ctx, cam } = this
    ctx.beginPath()
    ctx.arc(wx(cam, x), wy(cam, y), cam.scale * r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    if (text) {
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${Math.max(6, cam.scale * 0.95)}px Verdana, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, wx(cam, x), wy(cam, y) + 0.5)
    }
  }

  private drawBall(x: number, y: number, carrierIdx: number): void {
    const { ctx, cam } = this
    // Taşıyıcının altında kalmasın diye küçük bir görsel ofset
    const off = carrierIdx >= 0 ? 0.9 : 0
    const cx = wx(cam, x + off)
    const cy = wy(cam, y + off)
    ctx.beginPath()
    ctx.arc(cx, cy, cam.scale * 0.55, 0, Math.PI * 2)
    ctx.fillStyle = '#f5f5f0'
    ctx.fill()
    ctx.strokeStyle = '#555'
    ctx.lineWidth = Math.max(0.8, cam.scale * 0.12)
    ctx.stroke()
  }

  private drawLabel(x: number, y: number, name: string): void {
    const { ctx, cam } = this
    const cx = wx(cam, x)
    const cy = wy(cam, y) + cam.scale * 2.4
    ctx.font = `bold ${Math.max(8, cam.scale * 1.25)}px Verdana, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const wText = ctx.measureText(name).width
    ctx.fillStyle = 'rgba(20, 20, 20, 0.75)'
    ctx.fillRect(cx - wText / 2 - 3, cy - 1, wText + 6, cam.scale * 1.7 + 2)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(name, cx, cy)
  }
}
