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

  // Kalibrasyon regresyonu: gerçek maç istatistiklerine göre hedef bantlar.
  // Ortalamalar seed taraması üzerinden ölçülür; bantlar varyansa tolerans
  // bırakacak kadar geniş, sürüklenmeyi yakalayacak kadar dardır.
  const teamAvg = (f: (r: (typeof results)[number]) => number): number =>
    results.reduce((s, r) => s + f(r), 0) / N

  it('pas hacmi gerçekçi (takım başına ~400-850)', () => {
    for (const t of [0, 1] as const) {
      const avg = teamAvg((r) => r.stats.passes[t])
      expect(avg).toBeGreaterThan(350)
      expect(avg).toBeLessThan(900)
    }
  })

  it('faul gerçekçi (takım başına ~8-18)', () => {
    for (const t of [0, 1] as const) {
      const avg = teamAvg((r) => r.stats.fouls[t])
      expect(avg).toBeGreaterThan(5)
      expect(avg).toBeLessThan(19)
    }
  })

  it('korner gerçekçi (maç başına toplam ~4-12)', () => {
    const avg = teamAvg((r) => r.stats.corners[0] + r.stats.corners[1])
    expect(avg).toBeGreaterThan(3)
    expect(avg).toBeLessThan(14)
  })

  it('ofsayt var ve aşırı değil (maç başına toplam ~1-8)', () => {
    const avg = teamAvg((r) => r.stats.offsides[0] + r.stats.offsides[1])
    expect(avg).toBeGreaterThan(0.5)
    expect(avg).toBeLessThan(9)
  })

  it('toplam xG gol sayısıyla aynı mertebede (kalibrasyon tutarlılığı)', () => {
    const goals = teamAvg((r) => r.stats.goals[0] + r.stats.goals[1])
    const xg = teamAvg((r) => r.stats.xg[0] + r.stats.xg[1])
    expect(xg).toBeGreaterThan(goals * 0.5)
    expect(xg).toBeLessThan(goals * 2)
  })
})
