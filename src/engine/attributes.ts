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

// Enerjinin efektif hıza etkisi
export const energyFactor = (energy: number): number => 0.7 + 0.3 * energy
