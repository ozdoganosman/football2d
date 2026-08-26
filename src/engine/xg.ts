// Beklenen gol (xG): şutun konumundan gol olma olasılığı. Motor, şut sonucunu
// (isabet / direk / gol / kurtarış) karar anındaki `quality` (0..1) değerinden
// türetir; xG'yi de aynı zincirden hesaplarsak toplam xG gerçek gol sayısıyla
// tutarlı olur (kalibrasyon garantisi). Ortalama bir kaleciye karşı beklenen
// gol olarak modellenir (resolveShot ile birebir aynı formül).
//
// resolveShot zinciri:
//   offTargetP = min(0.78, 0.34 + 0.35*(1-quality))        → isabetsiz
//   woodwork  = 0.045 + quality*0.03                        → direk (isabetliyken)
//   goalP     = min(0.9, max(0.05, quality*(1.62-g*0.8)))   → gol (isabet+direk değil)
export function xgFromQuality(quality: number, g = 0.75): number {
  const onTarget = 1 - Math.min(0.78, 0.34 + 0.35 * (1 - quality))
  const notWood = 1 - (0.045 + quality * 0.03)
  const goalP = Math.min(0.9, Math.max(0.05, quality * (1.62 - g * 0.8)))
  return Math.max(0.01, Math.min(0.95, onTarget * notWood * goalP))
}
