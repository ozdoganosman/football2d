import {
  CENTER_CIRCLE_R,
  CORNER_ARC_R,
  GOAL_DEPTH,
  HALF_GOAL,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
  PENALTY_SPOT_DIST,
  SIX_YARD_DEPTH,
  SIX_YARD_WIDTH,
} from '../engine/constants'
import type { TeamInfo } from '../engine/types'

// Dünya kutusu (metre): saha + kenar boşlukları. Üstte kulübeler için pay var.
export const WORLD_W = 117
export const WORLD_H = 86
export const MARGIN_X = 6
export const MARGIN_TOP = 11
export const MARGIN_BOTTOM = 7

export interface Cam {
  scale: number
  ox: number // saha merkezinin canvas x'i
  oy: number
}

export function computeCam(canvasW: number, canvasH: number): Cam {
  const scale = Math.min(canvasW / WORLD_W, canvasH / WORLD_H)
  return {
    scale,
    ox: (MARGIN_X + HALF_LENGTH) * scale + (canvasW - WORLD_W * scale) / 2,
    oy: (MARGIN_TOP + HALF_WIDTH) * scale + (canvasH - WORLD_H * scale) / 2,
  }
}

export const wx = (cam: Cam, x: number): number => cam.ox + x * cam.scale
export const wy = (cam: Cam, y: number): number => cam.oy + y * cam.scale

const GRASS_DARK_BG = '#2e6325'
const GRASS_A = '#84bd55'
const GRASS_B = '#7bb24c'
const LINE = '#f2f6ee'

// Statik saha görüntüsü: koyu zemin, çizgili çim, beyaz çizgiler, kaleler, kulübeler.
export function drawPitch(
  ctx: CanvasRenderingContext2D,
  cam: Cam,
  canvasW: number,
  canvasH: number,
  teams: [TeamInfo, TeamInfo],
): void {
  ctx.fillStyle = GRASS_DARK_BG
  ctx.fillRect(0, 0, canvasW, canvasH)

  // Çim şeritleri (dikey, 10 şerit yarım sahada)
  const stripeW = (HALF_LENGTH * 2) / 14
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = i % 2 === 0 ? GRASS_A : GRASS_B
    ctx.fillRect(
      wx(cam, -HALF_LENGTH + i * stripeW),
      wy(cam, -HALF_WIDTH),
      stripeW * cam.scale + 1,
      HALF_WIDTH * 2 * cam.scale,
    )
  }

  ctx.strokeStyle = LINE
  ctx.lineWidth = Math.max(1.5, cam.scale * 0.35)
  ctx.lineJoin = 'round'

  // Dış çizgiler + orta çizgi
  ctx.strokeRect(
    wx(cam, -HALF_LENGTH),
    wy(cam, -HALF_WIDTH),
    HALF_LENGTH * 2 * cam.scale,
    HALF_WIDTH * 2 * cam.scale,
  )
  ctx.beginPath()
  ctx.moveTo(wx(cam, 0), wy(cam, -HALF_WIDTH))
  ctx.lineTo(wx(cam, 0), wy(cam, HALF_WIDTH))
  ctx.stroke()

  // Orta yuvarlak + nokta
  ctx.beginPath()
  ctx.arc(wx(cam, 0), wy(cam, 0), CENTER_CIRCLE_R * cam.scale, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(wx(cam, 0), wy(cam, 0), cam.scale * 0.4, 0, Math.PI * 2)
  ctx.fillStyle = LINE
  ctx.fill()

  for (const side of [-1, 1] as const) {
    const gx = side * HALF_LENGTH
    // Ceza sahası
    ctx.strokeRect(
      wx(cam, Math.min(gx, gx - side * PENALTY_AREA_DEPTH)),
      wy(cam, -PENALTY_AREA_WIDTH / 2),
      PENALTY_AREA_DEPTH * cam.scale,
      PENALTY_AREA_WIDTH * cam.scale,
    )
    // Altı pas
    ctx.strokeRect(
      wx(cam, Math.min(gx, gx - side * SIX_YARD_DEPTH)),
      wy(cam, -SIX_YARD_WIDTH / 2),
      SIX_YARD_DEPTH * cam.scale,
      SIX_YARD_WIDTH * cam.scale,
    )
    // Penaltı noktası
    const px = gx - side * PENALTY_SPOT_DIST
    ctx.beginPath()
    ctx.arc(wx(cam, px), wy(cam, 0), cam.scale * 0.35, 0, Math.PI * 2)
    ctx.fillStyle = LINE
    ctx.fill()
    // Penaltı yayı (D)
    ctx.beginPath()
    const boxEdge = gx - side * PENALTY_AREA_DEPTH
    const dx = Math.abs(boxEdge - px) // 5.5
    const ang = Math.acos(dx / CENTER_CIRCLE_R)
    if (side === 1) {
      ctx.arc(wx(cam, px), wy(cam, 0), CENTER_CIRCLE_R * cam.scale, Math.PI - ang, Math.PI + ang)
    } else {
      ctx.arc(wx(cam, px), wy(cam, 0), CENTER_CIRCLE_R * cam.scale, -ang, ang)
    }
    ctx.stroke()
    // Köşe yayları
    for (const cy of [-HALF_WIDTH, HALF_WIDTH]) {
      ctx.beginPath()
      ctx.arc(wx(cam, gx), wy(cam, cy), CORNER_ARC_R * cam.scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Kale (saha dışında beyaz kutu)
    ctx.fillStyle = '#e8ece4'
    ctx.fillRect(
      wx(cam, side === 1 ? gx : gx - GOAL_DEPTH),
      wy(cam, -HALF_GOAL),
      GOAL_DEPTH * cam.scale,
      HALF_GOAL * 2 * cam.scale,
    )
    ctx.strokeRect(
      wx(cam, side === 1 ? gx : gx - GOAL_DEPTH),
      wy(cam, -HALF_GOAL),
      GOAL_DEPTH * cam.scale,
      HALF_GOAL * 2 * cam.scale,
    )
  }

  drawBenches(ctx, cam, teams)
}

// Üst-orta yedek kulübeleri (kozmetik, FM görünümü)
function drawBenches(
  ctx: CanvasRenderingContext2D,
  cam: Cam,
  teams: [TeamInfo, TeamInfo],
): void {
  const benchW = 16
  const benchH = 3.6
  const gap = 4
  const y = -HALF_WIDTH - 7.5

  for (let t = 0; t < 2; t++) {
    const x0 = t === 0 ? -gap / 2 - benchW : gap / 2
    ctx.fillStyle = '#8ec167'
    ctx.strokeStyle = '#b03030'
    ctx.lineWidth = Math.max(1, cam.scale * 0.25)
    ctx.fillRect(wx(cam, x0), wy(cam, y), benchW * cam.scale, benchH * cam.scale)
    ctx.strokeRect(wx(cam, x0), wy(cam, y), benchW * cam.scale, benchH * cam.scale)

    const subs = teams[t].subs
    subs.forEach((s, i) => {
      const sx = x0 + 2 + i * ((benchW - 4) / Math.max(1, subs.length - 1))
      const sy = y + benchH / 2
      ctx.beginPath()
      ctx.arc(wx(cam, sx), wy(cam, sy), cam.scale * 0.95, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? teams[t].gkColor : teams[t].color
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = Math.max(1, cam.scale * 0.18)
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${Math.max(6, cam.scale * 1.05)}px Verdana, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(s.number), wx(cam, sx), wy(cam, sy) + 0.5)
    })
  }

  // Dördüncü hakem + teknik ekip noktaları
  ctx.beginPath()
  ctx.arc(wx(cam, 0), wy(cam, y + benchH / 2), cam.scale * 0.9, 0, Math.PI * 2)
  ctx.fillStyle = '#222'
  ctx.fill()
  for (const [i, gx] of [-2.5, 2.5].entries()) {
    ctx.beginPath()
    ctx.arc(wx(cam, gap / 2 + 16 + 3 + gx / 2 + i), wy(cam, y - 1.5), cam.scale * 0.8, 0, Math.PI * 2)
    ctx.fillStyle = '#3f9948'
    ctx.fill()
  }
}
