import { add, dist, norm, scale, sub } from './vec'
import type { Vec2 } from './types'

// Hedefe doğru hız sınırlı adım; hedefe 2 m kala yavaşlayarak varır (titreme önlenir).
export function stepToward(pos: Vec2, target: Vec2, speed: number, dt: number): Vec2 {
  const d = dist(pos, target)
  if (d < 1e-6) return pos
  const eff = d < 2 ? speed * Math.max(0.3, d / 2) : speed
  const step = Math.min(d, eff * dt)
  return add(pos, scale(norm(sub(target, pos)), step))
}
