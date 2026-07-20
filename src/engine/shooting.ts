import { gkSkill } from './attributes'
import type { PlayerSim } from './types'
import type { Rng } from './rng'

export type ShotOutcome =
  | { kind: 'goal' }
  | { kind: 'saved'; held: boolean } // held: kaleci topu kontrol etti
  | { kind: 'parried_corner' }
  | { kind: 'missed' }

// Şut varış anında çözülür. quality 0..1 karar anında hesaplanmıştır.
export function resolveShot(quality: number, keeper: PlayerSim | null, rng: Rng): ShotOutcome {
  const offTargetP = Math.min(0.75, 0.3 + 0.38 * (1 - quality))
  if (rng.chance(offTargetP)) return { kind: 'missed' }

  const g = keeper && !keeper.sentOff ? gkSkill(keeper.info.attributes) : 0.15
  const goalP = Math.min(0.9, Math.max(0.05, quality * (1.4 - g)))
  if (rng.chance(goalP)) return { kind: 'goal' }

  // Kurtarış: çoğunlukla kalecide kalır, bazen korner ya da öne çelme
  if (rng.chance(0.7)) return { kind: 'saved', held: true }
  if (rng.chance(0.5)) return { kind: 'parried_corner' }
  return { kind: 'saved', held: false } // öne çeldi → ceza sahasında boş top
}
