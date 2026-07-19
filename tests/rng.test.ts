import { describe, expect, it } from 'vitest'
import { createRng } from '../src/engine/rng'

describe('seeded RNG', () => {
  it('aynı seed aynı diziyi üretir', () => {
    const a = createRng(42)
    const b = createRng(42)
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('farklı seed farklı dizi üretir', () => {
    const a = createRng(1)
    const b = createRng(2)
    const seqA = Array.from({ length: 20 }, () => a.next())
    const seqB = Array.from({ length: 20 }, () => b.next())
    expect(seqA).not.toEqual(seqB)
  })

  it('[0,1) aralığında ve kabaca düzgün dağılır', () => {
    const rng = createRng(7)
    let sum = 0
    const n = 10000
    for (let i = 0; i < n; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      sum += v
    }
    expect(sum / n).toBeGreaterThan(0.47)
    expect(sum / n).toBeLessThan(0.53)
  })

  it('int uçları kapsar', () => {
    const rng = createRng(3)
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(rng.int(1, 3))
    expect([...seen].sort()).toEqual([1, 2, 3])
  })
})
