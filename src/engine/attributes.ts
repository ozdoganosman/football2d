import type { PlayerAttributes } from './types'

// Nitelik (1–20) → motor katsayıları. Tüm eşlemeler burada toplanır ki
// denge ayarı tek dosyadan yapılabilsin.

// Sprint hızı m/s: pace 1 → ~5.0, pace 20 → ~8.4
export const maxSpeed = (a: PlayerAttributes): number => 4.8 + (a.pace / 20) * 3.6

// Pas hedef sapması (hedefte metre sapma / pas mesafesi oranı)
export const passErrorRate = (a: PlayerAttributes): number => 0.16 * (1.2 - a.passing / 20)

// Pas hızı m/s
export const passSpeed = (a: PlayerAttributes): number => 13 + (a.passing / 20) * 5

// Şut kalitesi çarpanı 0..1
export const shootSkill = (a: PlayerAttributes): number => 0.35 + (a.shooting / 20) * 0.65

// Top sürme becerisi 0..1 (müdahaleye direnç)
export const dribbleSkill = (a: PlayerAttributes): number => 0.3 + (a.dribbling / 20) * 0.7

// İlk dokunuş / top kontrolü 0..1 (top sürme + pas karışımı)
export const controlSkill = (a: PlayerAttributes): number =>
  0.35 + ((a.dribbling + a.passing) / 2 / 20) * 0.65

// Müdahale becerisi 0..1
export const tackleSkill = (a: PlayerAttributes): number => 0.3 + (a.tackling / 20) * 0.7

// Araya girme / boş top kapma becerisi 0..1
export const interceptSkill = (a: PlayerAttributes): number => 0.3 + (a.positioning / 20) * 0.7

// Kurtarış becerisi 0..1
export const gkSkill = (a: PlayerAttributes): number => 0.35 + (a.goalkeeping / 20) * 0.6

// Enerji tüketimi: koşulan metre başına düşüş (stamina yüksekse az düşer)
export const drainPerMeter = (a: PlayerAttributes): number =>
  0.000045 * (1.6 - a.stamina / 20)

// Hava topu mücadelesi 0.35..0.9: boy baskın, güç ve zamanlama (pozisyon)
// katkı. Uzun/güçlü oyuncu ikili hava mücadelesini kazanır.
export const aerialSkill = (a: PlayerAttributes): number =>
  0.35 + ((a.height * 0.5 + a.strength * 0.3 + a.positioning * 0.2) / 20) * 0.58

// Kafa vuruşunu yönlendirme/bitirme 0.3..0.95: kafa niteliği + boy
export const headingSkill = (a: PlayerAttributes): number =>
  0.3 + ((a.heading * 0.7 + a.height * 0.3) / 20) * 0.65

// Soğukkanlılık çarpanı: bitiricilik/penaltı. Tipik değerde (12) TAM nötr
// (=1.0) — ortalamayı şişirmez, yalnız farklılaştırır: soğukkanlı bitirici
// daha çok gol, tez canlı daha çok harcar. 0.94..1.04
export const composureFactor = (a: PlayerAttributes): number =>
  0.88 + (a.composure / 20) * 0.2

// Enerjinin efektif hıza etkisi: 0.6 enerji üstünde orijinal eğriyle aynı
// (erken/orta maç temposu korunur), altında ek ceza hızla büyür — yalnız
// gerçekten bitkin oyuncu geç maçta belirgin yavaşlar
export const energyFactor = (energy: number): number => {
  const base = 0.7 + 0.3 * energy
  return energy >= 0.6 ? base : base - (0.6 - energy) * 0.5
}
