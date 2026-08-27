import { HALF_GOAL } from './constants'
import { composureFactor, gkSkill, shootSkill } from './attributes'
import type { PlayerSim, Vec2 } from './types'
import type { Rng } from './rng'

// GEOMETRİK ŞUT MODELİ. Sonuç önceden zarla seçilmez:
//   1) Şutör kale ağzında gerçek bir noktaya nişan alır (köşe tercih edilir).
//   2) Yürütme hatası örneklenir (mesafe/baskı ile büyür, beceriyle küçülür).
//   3) Topun kale düzlemini kestiği nokta (y, z) bulunur.
//   4) Kaleci GERÇEK konumundan, reaksiyon süresi sonrası kalan sürede
//      uzanabildiği mesafeyle karşılaştırılır: yetişirse kurtarır, yetişemezse
//      gol. Direk bantları çerçeve kenarlarında fiziksel olarak yaşar.
// Gol, kurtarış, aut ve direk bu geometriden KENDİLİĞİNDEN doğar; xG aynı
// geometrinin sayısal integrali olarak hesaplanır (xg.ts).

export const GOAL_HEIGHT = 2.44
const POST_BAND = 0.07 // direk yarıçapı (~12 cm çap)
const BAR_LO = GOAL_HEIGHT - 0.07
const BAR_HI = GOAL_HEIGHT + 0.07

export type ShotOutcome =
  | { kind: 'goal' }
  | { kind: 'saved'; held: boolean } // held: kaleci topu kontrol etti
  | { kind: 'parried_corner' }
  | { kind: 'woodwork' } // direğe/üst direğe çarptı
  | { kind: 'missed' }

// Şut planı: sonuç + kale düzlemindeki gerçek kesişme noktası (görsel ve
// kaleci dalışı bu noktaya oynar — sonuç ve animasyon aynı gerçeği anlatır)
export interface ShotPlan {
  outcome: ShotOutcome
  targetY: number // kale düzleminde saha-y (m); |y|>3.66 = dışarı
  targetZ: number // kale düzleminde yükseklik (m); >2.44 = üstten aut
}

// ~N(0,1): üç uniform toplamı (Irwin-Hall) — ucuz, determinist, aralık ±3σ
function gauss(rng: Rng): number {
  return (rng.next() + rng.next() + rng.next() - 1.5) * 2
}

// Yürütme sapması (metre, kale düzleminde): açısal hata × mesafe.
// Beceri hatayı daraltır, baskı ve yorgun ayak büyütür.
export function shotSigmas(
  shooter: PlayerSim,
  d: number,
  pressure01: number,
  headed = false,
): { sigY: number; sigZ: number } {
  const skill = shootSkill(shooter.info.attributes) // 0.35..1.0
  const comp = composureFactor(shooter.info.attributes) // 0.88..1.08
  const fatigue = shooter.energy < 0.7 ? (0.7 - shooter.energy) * 0.35 : 0
  // Açısal σ (radyan mertebesi): maç koşullarında yürütme hatası büyüktür —
  // gerçek futbolda şutların ~%40-50'si çerçeveyi bulmaz. Elit ~0.035,
  // zayıf ~0.09; baskı ve yorgunluk ekler; kafa vuruşu çok daha dağınıktır.
  const angular =
    (0.055 + 0.058 * (1 - skill) + 0.028 * pressure01 * (2.06 - comp) + fatigue * 0.03) *
    (headed ? 1.9 : 1)
  // TABAN saçılma: yakın mesafede bile şut cerrahi değildir (hareket halindeki
  // topa, temas altında vuruş) — nokta atışı yakın vuruş diye bir şey yok
  const sigY = Math.max(headed ? 1.4 : 1.18, d * angular)
  const sigZ = Math.max(headed ? 0.88 : 0.7, d * angular * 0.8)
  return { sigY, sigZ }
}

// Kaleci kurtarış testi — AÇI KAPATMA GEOMETRİSİYLE. Kesişme kalecinin
// KENDİ düzleminde test edilir: çizgisinden açılan kaleci topun yanal
// açılımını daraltılmış görür (açıyı kapatır) ama tepki süresi kısalır;
// çizgisine yapışık kaleci tam genişlikle ama daha uzun süreyle karşılaşır.
// Dönüş: marj (m). >0 = uzanır (büyüklük rahatlık), <0 = gol.
export function saveMargin(
  keeper: PlayerSim,
  from: Vec2,
  goalX: number,
  yc: number,
  zc: number,
  flightT: number,
  quality: number,
): number {
  const g = gkSkill(keeper.info.attributes) // 0.35..0.95
  // Antisipasyon: kaleci vuruş hareketini OKUR — etkin reaksiyon kısadır
  const reaction = 0.05 + (1 - g) * 0.12 + quality * 0.06
  // Kalecinin düzlemi: from → (goalX, yc) doğrusunun kaleci x'indeki kesiti
  const span = goalX - from.x
  const frac = Math.abs(span) < 1e-6 ? 1 : Math.max(0.25, Math.min(1, (keeper.pos.x - from.x) / span))
  const yAtK = from.y + (yc - from.y) * frac
  const zAtK = 0.25 + (zc - 0.25) * frac
  // Üstünden aşırtma: kaleci düzleminde top sıçrama erişiminin üstündeyse
  // dokunamaz (çizgisinden açılan kaleciye lob — doğal ceza)
  if (zAtK > 2.35) return -1
  const flightToK = flightT * frac
  const moveT = Math.max(0, flightToK - reaction)
  const diveSpeed = 5.4 + 3.6 * g // adım + dalış birleşik etkin hız
  // Erişim DOYAR: uzun uçuş süresi kaleciyi sonsuz genişletmez — insan
  // gövdesinin dalış menzili sınırlıdır (köşeye iyi plase uzaktan da işler)
  const reachCap = 2.95 + 1.28 * g
  const reach = Math.min(reachCap, 1.2 + moveT * diveSpeed) * reachFactorForHeight(zAtK)
  return reach - Math.abs(yAtK - keeper.pos.y)
}

// Kesişme noktasına uzanma çarpanı: alçak top (yere yatma) ve üst köşe
// (tam gerilme) erişimi kısar; orta yükseklik en kolayıdır.
export function reachFactorForHeight(z: number): number {
  if (z < 0.55) return 0.86 // yere inmek zaman alır
  if (z > 1.9) return 0.9 // üst köşeye tam gerilme
  return 1
}

// Şutu planla: nişan + hata → kesişme; kaleciyle geometrik karşılaştırma.
export function planShot(opts: {
  from: Vec2
  dir: 1 | -1
  goalX: number
  shooter: PlayerSim
  keeper: PlayerSim | null
  quality: number // pozisyon kalitesi 0..1 (baskı/açı/mesafe özeti)
  pressure01: number // en yakın rakip baskısı 0..1
  flightT: number // uçuş süresi (sn)
  rng: Rng
  isPenalty?: boolean
  headed?: boolean // kafa vuruşu: daha dağınık, daha yavaş
}): ShotPlan {
  const { from, goalX, shooter, keeper, quality, pressure01, flightT, rng, isPenalty, headed } = opts
  const d = Math.max(1, Math.hypot(goalX - from.x, from.y))

  // 1) Nişan: köşeler değerli. İyi bitirici köşeye daha cesur nişan alır;
  // baskı altında emniyet payı artar (ortaya doğru).
  const skill = shootSkill(shooter.info.attributes)
  let aimY: number
  let aimZ: number
  if (isPenalty) {
    const side = rng.chance(0.5) ? 1 : -1
    aimY = side * (HALF_GOAL - 0.7)
    aimZ = rng.chance(0.24) ? 1.65 : 0.5
  } else {
    // Uzak köşe hafif tercihli (çapraz bitirme içgüdüsü)
    const farSign = from.y > 0 ? -1 : 1
    const side = rng.chance(0.62) ? farSign : -farSign
    const cornerMargin = 0.35 + (1 - skill) * 0.45 + pressure01 * 0.3
    aimY = side * Math.max(0.4, HALF_GOAL - cornerMargin)
    // Çoğunlukla yerden (köşeye sert), bazen yükseğe (üst köşe/aşırtma)
    aimZ = rng.chance(0.3 + skill * 0.1) ? rng.range(1.4, 2.1) : rng.range(0.2, 0.8)
  }

  // 2) Yürütme hatası → kesişme noktası
  const { sigY, sigZ } = isPenalty
    ? {
        sigY: 0.31 + 0.55 * (1.08 - composureFactor(shooter.info.attributes)),
        sigZ: 0.3,
      }
    : shotSigmas(shooter, d, pressure01, headed)
  const yc = aimY + gauss(rng) * sigY
  const zc = Math.max(0.05, aimZ + gauss(rng) * sigZ)

  // 3) Çerçeve testi (direk bantları fiziksel)
  const absY = Math.abs(yc)
  const onPost = absY >= HALF_GOAL - POST_BAND && absY <= HALF_GOAL + POST_BAND && zc < BAR_HI
  const onBar = zc >= BAR_LO && zc <= BAR_HI && absY < HALF_GOAL + POST_BAND
  if (onPost || onBar) {
    return { outcome: { kind: 'woodwork' }, targetY: yc, targetZ: Math.min(zc, GOAL_HEIGHT) }
  }
  if (absY > HALF_GOAL - POST_BAND || zc > BAR_LO) {
    return { outcome: { kind: 'missed' }, targetY: yc, targetZ: zc }
  }

  // 4) Kaleci: gerçek konumundan kesişmeye uzanabiliyor mu?
  if (!keeper || keeper.sentOff) {
    return { outcome: { kind: 'goal' }, targetY: yc, targetZ: zc }
  }
  if (isPenalty) {
    // Penaltıda kaleci köşe SEÇER: doğru köşeyi tutarsa erken hareketin
    // avantajıyla uzanır, yanlış köşede yalnız refleks/kol boyu kalır
    const g = gkSkill(keeper.info.attributes)
    const guessedRight = rng.chance(0.44)
    const reach = (guessedRight ? 1.12 + flightT * (2.45 + 2.4 * g) : 0.85) * reachFactorForHeight(zc)
    const gap = guessedRight ? Math.abs(yc - keeper.pos.y) : 99
    if (gap <= reach) {
      const margin = reach - gap
      if (margin > 0.55) return { outcome: { kind: 'saved', held: true }, targetY: yc, targetZ: zc }
      if (rng.chance(0.5)) return { outcome: { kind: 'parried_corner' }, targetY: yc, targetZ: zc }
      return { outcome: { kind: 'saved', held: false }, targetY: yc, targetZ: zc }
    }
    return { outcome: { kind: 'goal' }, targetY: yc, targetZ: zc }
  }
  const margin = saveMargin(keeper, from, goalX, yc, zc, flightT, quality)
  if (margin < 0) {
    return { outcome: { kind: 'goal' }, targetY: yc, targetZ: zc }
  }
  // Yetişti: marj büyükse kucaklar, küçükse çeler (parmak ucu)
  if (margin > 1.0) return { outcome: { kind: 'saved', held: true }, targetY: yc, targetZ: zc }
  if (margin > 0.35) {
    return rng.chance(0.65)
      ? { outcome: { kind: 'saved', held: true }, targetY: yc, targetZ: zc }
      : { outcome: { kind: 'saved', held: false }, targetY: yc, targetZ: zc }
  }
  // Parmak ucu: kornere çelme / öne çelme
  if (rng.chance(0.5)) return { outcome: { kind: 'parried_corner' }, targetY: yc, targetZ: zc }
  return { outcome: { kind: 'saved', held: false }, targetY: yc, targetZ: zc }
}
