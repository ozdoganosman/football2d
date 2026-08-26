import { dribbleSkill, tackleSkill } from './attributes'
import { sharpness } from './stamina'
import { dist } from './vec'
import type { PlayerSim } from './types'
import type { Rng } from './rng'

export type TackleOutcome =
  | { kind: 'none' }
  | { kind: 'foul'; tacklerId: number }
  | { kind: 'won'; tacklerId: number; toFeet: boolean } // toFeet: top müdahaleyi yapanda kalır
  | { kind: 'beaten'; tacklerId: number } // çalım yedi, cooldown'a girer

// Topu taşıyana yakın savunmacıların müdahale denemeleri. Tick başına çağrılır.
export function attemptTackle(
  carrier: PlayerSim,
  opponents: PlayerSim[],
  rng: Rng,
): TackleOutcome {
  for (const def of opponents) {
    if (def.sentOff || def.tackleCooldown > 0 || def.info.role === 'GK') continue
    // Çarpışma tabanı 2.0 m: temas bölgesi 2.0-2.4 arasıdır
    if (dist(def.pos, carrier.pos) > 2.4) continue
    // Temas var; topu sürene karşı müdahale gerçek bir tehdit olmalı
    if (!rng.chance(0.18)) continue

    if (rng.chance(0.0085)) return { kind: 'foul', tacklerId: def.id }

    const t = tackleSkill(def.info.attributes)
    const d = dribbleSkill(carrier.info.attributes)
    // Yorgun defans mistiming yapar: kazanma olasılığı keskinlikle hafif düşer
    // (yumuşak — geç maçta savunmayı çökertmeden gerçekçi bir etki)
    const winP = 0.78 * (t / (t + d)) * (0.75 + 0.25 * sharpness(def.energy))
    if (rng.chance(winP)) {
      return { kind: 'won', tacklerId: def.id, toFeet: rng.chance(0.5) }
    }
    return { kind: 'beaten', tacklerId: def.id } // cooldown'u engine kısa tutar
  }
  return { kind: 'none' }
}
