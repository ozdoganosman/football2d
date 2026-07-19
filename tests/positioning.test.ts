import { describe, expect, it } from 'vitest'
import { FORMATIONS } from '../src/engine/formations'
import { targetPosition } from '../src/engine/positioning'
import { HALF_LENGTH, HALF_WIDTH } from '../src/engine/constants'
import { vec } from '../src/engine/vec'

const slots = FORMATIONS['4-4-2']

describe('blok kayması', () => {
  it('top ileri gidince blok öne kayar (+x hücumu)', () => {
    const cb = slots[2] // stoper
    const deep = targetPosition(cb, 1, vec(-30, 0), false)
    const high = targetPosition(cb, 1, vec(30, 0), false)
    expect(high.x).toBeGreaterThan(deep.x)
  })

  it('top yana gidince blok yana kayar', () => {
    const cm = slots[6]
    const left = targetPosition(cm, 1, vec(0, -20), false)
    const right = targetPosition(cm, 1, vec(0, 20), false)
    expect(right.y).toBeGreaterThan(left.y)
  })

  it('topa sahip takım daha geniş ve önde oynar', () => {
    const wideMid = slots[5] // sol orta saha
    const ball = vec(0, 0)
    const withBall = targetPosition(wideMid, 1, ball, true)
    const withoutBall = targetPosition(wideMid, 1, ball, false)
    expect(withBall.x).toBeGreaterThan(withoutBall.x)
    expect(Math.abs(withBall.y)).toBeGreaterThan(Math.abs(withoutBall.y))
  })

  it('hedefler her zaman saha sınırları içinde', () => {
    for (const slot of slots) {
      for (const bx of [-52, -20, 0, 20, 52]) {
        for (const by of [-33, 0, 33]) {
          for (const poss of [true, false]) {
            for (const dir of [1, -1] as const) {
              const t = targetPosition(slot, dir, vec(bx, by), poss)
              expect(Math.abs(t.x)).toBeLessThanOrEqual(HALF_LENGTH)
              expect(Math.abs(t.y)).toBeLessThanOrEqual(HALF_WIDTH)
            }
          }
        }
      }
    }
  })

  it('aynalama simetrik: -x hücumu +x hücumunun aynası', () => {
    const lb = slots[1]
    const ball = vec(10, 5)
    const plus = targetPosition(lb, 1, ball, false)
    const minus = targetPosition(lb, -1, vec(-10, -5), false)
    expect(minus.x).toBeCloseTo(-plus.x, 5)
    expect(minus.y).toBeCloseTo(-plus.y, 5)
  })
})
