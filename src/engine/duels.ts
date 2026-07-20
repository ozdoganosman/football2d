import { dribbleSkill, tackleSkill } from './attributes'
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
    if (dist(def.pos, carrier.pos) > 1.5) continue
    // Temas var; müdahale nadir ama anlamlı olmalı (her temas 50/50 değil)
    if (!rng.chance(0.1)) continue

    if (rng.chance(0.04)) return { kind: 'foul', tacklerId: def.id }

    const t = tackleSkill(def.info.attributes)
    const d = dribbleSkill(carrier.info.attributes)
    const winP = 0.75 * (t / (t + d))
    if (rng.chance(winP)) {
      return { kind: 'won', tacklerId: def.id, toFeet: rng.chance(0.5) }
    }
    return { kind: 'beaten', tacklerId: def.id } // cooldown'u engine kısa tutar
  }
  return { kind: 'none' }
}
