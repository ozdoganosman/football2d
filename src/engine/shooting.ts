import { gkSkill } from './attributes'
import type { PlayerSim } from './types'
import type { Rng } from './rng'

export type ShotOutcome =
  | { kind: 'goal' }
  | { kind: 'saved'; held: boolean } // held: kaleci topu kontrol etti
  | { kind: 'parried_corner' }
  | { kind: 'woodwork' } // direğe/üst direğe çarptı
  | { kind: 'missed' }

// Şut varış anında çözülür. quality 0..1 karar anında hesaplanmıştır.
// isPenalty: beyaz noktadan vuruş — gerçekçi ~%75 dönüşüm (isabetsizlik/direk
// düşük, golP yüksek), normal şuttan ayrı eğri.
export function resolveShot(
  quality: number,
  keeper: PlayerSim | null,
  rng: Rng,
  isPenalty = false,
): ShotOutcome {
  const g = keeper && !keeper.sentOff ? gkSkill(keeper.info.attributes) : 0.15

  if (isPenalty) {
    if (rng.chance(0.08)) return { kind: 'missed' } // dışarı/üstten (nadir)
    if (rng.chance(0.04)) return { kind: 'woodwork' }
    // golP ~0.83..0.94; iyi kaleci bir miktar kurtarır → ~%75-83 dönüşüm
    const goalP = Math.min(0.94, Math.max(0.6, quality * (1.35 - g * 0.45)))
    if (rng.chance(goalP)) return { kind: 'goal' }
    if (rng.chance(0.5)) return { kind: 'saved', held: true }
    if (rng.chance(0.5)) return { kind: 'parried_corner' }
    return { kind: 'saved', held: false }
  }

  const offTargetP = Math.min(0.78, 0.34 + 0.35 * (1 - quality))
  if (rng.chance(offTargetP)) return { kind: 'missed' }

  // Direk/üst direk: köşeye giden isabetli şutların küçük bir kısmı çerçeveye
  // çarpar (gerçek futbolda tüm şutların ~%1-2'si). İyi şutta biraz daha olası.
  if (rng.chance(0.045 + quality * 0.03)) return { kind: 'woodwork' }

  const goalP = Math.min(0.9, Math.max(0.05, quality * (1.62 - g * 0.8)))
  if (rng.chance(goalP)) return { kind: 'goal' }

  // Kurtarış: çoğunlukla kalecide kalır, bazen korner ya da öne çelme
  if (rng.chance(0.62)) return { kind: 'saved', held: true }
  if (rng.chance(0.58)) return { kind: 'parried_corner' }
  return { kind: 'saved', held: false } // öne çeldi → ceza sahasında boş top
}
