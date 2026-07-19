import { describe, expect, it } from 'vitest'
import { simulateMatch } from '../src/engine/engine'
import { FRAME_STRIDE, HALF_SECONDS } from '../src/engine/constants'
import { KIZILKAYA, MAVIDERE } from '../src/data/teams'

describe('maç motoru', () => {
  it('deterministik: aynı seed birebir aynı maçı üretir', () => {
    const a = simulateMatch(KIZILKAYA, MAVIDERE, 12345)
    const b = simulateMatch(KIZILKAYA, MAVIDERE, 12345)
    expect(a.frameCount).toBe(b.frameCount)
    expect(a.events.length).toBe(b.events.length)
    expect(a.stats).toEqual(b.stats)
    // Kare verisi birebir aynı (örneklenmiş karşılaştırma + tam uzunluk)
    expect(a.frames.length).toBe(b.frames.length)
    for (let i = 0; i < a.frames.length; i += 997) {
      expect(a.frames[i]).toBe(b.frames[i])
    }
  })

  it('farklı seed farklı maç üretir', () => {
    const a = simulateMatch(KIZILKAYA, MAVIDERE, 1)
    const b = simulateMatch(KIZILKAYA, MAVIDERE, 2)
    let diff = false
    for (let i = 0; i < Math.min(a.frames.length, b.frames.length); i += 101) {
      if (a.frames[i] !== b.frames[i]) {
        diff = true
        break
      }
    }
    expect(diff).toBe(true)
  })

  it('maç geçerli şekilde tamamlanır', () => {
    const r = simulateMatch(KIZILKAYA, MAVIDERE, 777)
    expect(r.frameCount).toBeGreaterThan(HALF_SECONDS * 2 * 10)
    expect(r.frames.length).toBe(r.frameCount * FRAME_STRIDE)
    expect(r.events.at(-1)?.kind).toBe('full_time')
    expect(r.events.filter((e) => e.kind === 'half_end')).toHaveLength(1)

    // Skor gol olaylarıyla tutarlı
    const goals = r.events.filter((e) => e.kind === 'goal')
    expect(goals.filter((g) => g.teamIdx === 0).length).toBe(r.stats.goals[0])
    expect(goals.filter((g) => g.teamIdx === 1).length).toBe(r.stats.goals[1])

    // İsabetli şut sayısı şuttan fazla olamaz
    for (const t of [0, 1] as const) {
      expect(r.stats.shotsOnTarget[t]).toBeLessThanOrEqual(r.stats.shots[t])
      expect(r.stats.goals[t]).toBeLessThanOrEqual(r.stats.shotsOnTarget[t])
    }

    // Topla oynama toplamı ~100
    expect(r.stats.possession[0] + r.stats.possession[1]).toBeGreaterThanOrEqual(99)
    expect(r.stats.possession[0] + r.stats.possession[1]).toBeLessThanOrEqual(101)

    // Tüm kareler sonlu değerler içerir
    for (let i = 0; i < r.frames.length; i += 499) {
      expect(Number.isFinite(r.frames[i])).toBe(true)
    }
  })

  it('önemli anlar pencereleri geçerli ve sıralı', () => {
    const r = simulateMatch(KIZILKAYA, MAVIDERE, 42)
    expect(r.highlights.length).toBeGreaterThan(0)
    let prev = -1
    for (const w of r.highlights) {
      expect(w.startTick).toBeLessThanOrEqual(w.endTick)
      expect(w.startTick).toBeGreaterThan(prev)
      expect(w.endTick).toBeLessThan(r.frameCount)
      prev = w.endTick
    }
  })
})
