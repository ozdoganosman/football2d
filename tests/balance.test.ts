import { describe, expect, it } from 'vitest'
import { simulateMatch } from '../src/engine/engine'
import { KIZILKAYA, MAVIDERE } from '../src/data/teams'

// İstatistiksel denge testleri: tek maç değil, seed taraması üzerinden
// makul aralıklar doğrulanır.
describe('denge', () => {
  const N = 12
  const results = Array.from({ length: N }, (_, i) =>
    simulateMatch(KIZILKAYA, MAVIDERE, 1000 + i),
  )

  it('gol ortalaması gerçekçi aralıkta (maç başına ~1-5)', () => {
    const total = results.reduce((s, r) => s + r.stats.goals[0] + r.stats.goals[1], 0)
    const avg = total / N
    expect(avg).toBeGreaterThan(0.7)
    expect(avg).toBeLessThan(6)
  })

  it('şut sayıları gerçekçi (maç başına takım başı ~4-30)', () => {
    const shots = results.reduce((s, r) => s + r.stats.shots[0] + r.stats.shots[1], 0) / (2 * N)
    expect(shots).toBeGreaterThan(3)
    expect(shots).toBeLessThan(35)
  })

  it('pas isabeti makul (%50-95)', () => {
    for (const r of results) {
      for (const t of [0, 1] as const) {
        if (r.stats.passes[t] > 20) {
          const acc = r.stats.passesCompleted[t] / r.stats.passes[t]
          expect(acc).toBeGreaterThan(0.4)
          expect(acc).toBeLessThan(0.97)
        }
      }
    }
  })
})
