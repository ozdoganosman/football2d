import { HALF_LENGTH, HALF_WIDTH } from './constants'
import { stepToward } from './movement'
import type { Vec2 } from './types'

// Hakem topu çapraz geriden takip eder (kozmetik).
export function refereeTarget(ball: Vec2): Vec2 {
  const sign = ball.x >= 0 ? 1 : -1
  return {
    x: Math.max(-HALF_LENGTH + 8, Math.min(HALF_LENGTH - 8, ball.x - sign * 9)),
    y: Math.max(-HALF_WIDTH + 6, Math.min(HALF_WIDTH - 6, ball.y * 0.65)),
  }
}

export function moveReferee(pos: Vec2, ball: Vec2, dt: number): Vec2 {
  return stepToward(pos, refereeTarget(ball), 6.6, dt)
}
