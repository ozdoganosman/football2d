import { HALF_GOAL } from './constants'
import { shootSkill } from './attributes'
import { saveMargin, shotSigmas } from './shooting'
import type { PlayerSim, Vec2 } from './types'

// Beklenen gol (xG): planShot ile AYNI geometrinin sayısal integrali.
// Nişan dağılımı (uzak/yakın köşe, alçak/yüksek) ve yürütme hatası üzerinde
// deterministik quantile ızgarasıyla marginalize edilir; kaleci erişimi şut
// anındaki GERÇEK kaleci konumundan hesaplanır. RNG kullanmaz — aynı şut
// pozisyonu her zaman aynı xG'yi üretir ve toplam xG, golle aynı süreçten
// türediği için kalibre kalır.

const POST_BAND = 0.07
const BAR_LO = 2.44 - 0.07

// N(0,1) için Gauss-Hermite düğümleri (kuyruklar dahil doğru integrasyon)
const QY: Array<[number, number]> = [
  [-3.7504, 0.0005483], [-2.3668, 0.03076], [-1.1544, 0.2401],
  [0, 0.4530],
  [1.1544, 0.2401], [2.3668, 0.03076], [3.7504, 0.0005483],
]
const QZ: Array<[number, number]> = [
  [-2.857, 0.011257], [-1.3556, 0.2221], [0, 0.5333], [1.3556, 0.2221], [2.857, 0.011257],
]

export function xgGeometric(opts: {
  from: Vec2
  goalX: number
  shooter: PlayerSim
  keeper: PlayerSim | null
  quality: number
  pressure01: number
  flightT: number
  headed?: boolean
}): number {
  const { from, goalX, shooter, keeper, quality, pressure01, flightT, headed } = opts
  const d = Math.max(1, Math.hypot(goalX - from.x, from.y))
  const skill = shootSkill(shooter.info.attributes)
  const { sigY, sigZ } = shotSigmas(shooter, d, pressure01, headed)

  const hasKeeper = !!keeper && !keeper.sentOff

  // Nişan kombinasyonları: (uzak %62 / yakın %38 köşe) × (alçak / yüksek)
  const farSign = from.y > 0 ? -1 : 1
  const cornerMargin = 0.35 + (1 - skill) * 0.45 + pressure01 * 0.3
  const aimAbsY = Math.max(0.4, HALF_GOAL - cornerMargin)
  const pHigh = 0.3 + skill * 0.1
  const combos: Array<{ w: number; aimY: number; aimZ: number }> = [
    { w: 0.62 * (1 - pHigh), aimY: farSign * aimAbsY, aimZ: 0.5 },
    { w: 0.62 * pHigh, aimY: farSign * aimAbsY, aimZ: 1.75 },
    { w: 0.38 * (1 - pHigh), aimY: -farSign * aimAbsY, aimZ: 0.5 },
    { w: 0.38 * pHigh, aimY: -farSign * aimAbsY, aimZ: 1.75 },
  ]

  let p = 0
  for (const c of combos) {
    let pc = 0
    for (const [qy, wy] of QY) {
      const yc = c.aimY + qy * sigY
      const absY = Math.abs(yc)
      if (absY > HALF_GOAL - POST_BAND) continue // dışarı ya da direk bandı
      for (const [qz, wz] of QZ) {
        const zc = Math.max(0.05, c.aimZ + qz * sigZ)
        if (zc > BAR_LO) continue // üstten aut / üst direk bandı
        if (!hasKeeper) {
          pc += wy * wz
          continue
        }
        if (saveMargin(keeper!, from, goalX, yc, zc, flightT, quality) < 0) pc += wy * wz
      }
    }
    p += c.w * pc
  }
  return Math.max(0.01, Math.min(0.95, p))
}
