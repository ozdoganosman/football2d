// Organik kondisyon modeli. İki havuz + maç-boyu tavan + oyuncu-bazlı varyasyon.
// Taze durum (energy=1, sprintReserve=1) mevcut davranışla BİREBİR aynıdır;
// organik katmanlar oyuncu yoruldukça devreye girer.

// Aerobik yakım: mesafe-tabanlı (mevcut kalibrasyona yakın) × yoğunluk × motor.
// intensity 0 (dururken) .. 1 (tam sprint); yüksek yoğunluk metre başına daha
// çok yakar. engine: oyuncu-bazlı küçük organik varyasyon (~0.92..1.08).
export function aerobicDrain(
  moved: number,
  stamina: number,
  intensity: number,
  engine: number,
): number {
  const perMeter = 0.000045 * (1.6 - stamina / 20)
  return moved * perMeter * (0.7 + 0.6 * intensity) * engine
}

// Aerobik toparlanma: yalnız düşük yoğunlukta, sürekli — ama yakımı tam
// karşılamaz (net eğim aşağı; oyuncu 90' boyunca yavaşça erir). dt saniye.
export function aerobicRecover(stamina: number, intensity: number, dt: number): number {
  if (intensity >= 0.4) return 0
  return dt * 0.0009 * ((0.4 - intensity) / 0.4) * (0.6 + stamina / 40)
}

// Kondisyon tavanı: maç ilerledikçe (prog 0..1) düşer. Dinlenmek bile enerjiyi
// bunun üstüne çıkaramaz → 90'da herkes 1'deki kadar taze olamaz (elit ~0.72,
// düşük stamina ~0.55). Oyuncu genelde tavanın ALTINDA erir; tavan yalnız uzun
// dinlenmede tam toparlanmayı engeller. "Organik maç-boyu erime".
export function energyCeiling(prog: number, stamina: number): number {
  return 1 - prog * (0.33 + ((20 - stamina) / 20) * 0.2)
}

// Sprint tavanı: rezerv doluyken tam hız (etkisiz), boşaldıkça sprint düşer —
// "üst üste koşamama". reserve 1 → 1.0, 0 → 0.85 (yumuşak; normal oyunda
// rezerv çoğunlukla dolu kalır, yalnız üst üste sprintte belirgin düşer).
export function sprintCap(reserve: number): number {
  return 0.85 + 0.15 * reserve
}

// İcra keskinliği (müdahale/hava/ilk dokunuş/karar): 0.7 üstünde 1.0
// (mevcut denge korunur), altında pürüzsüz düşer. energy 0.15 → ~0.67.
export function sharpness(energy: number): number {
  return energy >= 0.7 ? 1 : 1 - (0.7 - energy) * 0.6
}

// Çeviklik faktörü (dönüş/hızlanma): energy=1 → 1.0 (etkisiz), yorgunlukla mild
// düşer. Taze oyuncuda mevcut davranışı korur.
export function agilityFactor(energy: number): number {
  return 0.75 + 0.25 * energy
}

// Oyuncu-bazlı deterministik "motor" varyasyonu: herkes birebir aynı erimez.
export function enginePace(id: number): number {
  const h = (id * 2654435761 + 1013904223) >>> 0
  return 0.92 + ((h % 1000) / 1000) * 0.16 // 0.92..1.08
}
