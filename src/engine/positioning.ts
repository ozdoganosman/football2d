import { HALF_LENGTH, HALF_WIDTH } from './constants'
import type { FormationSlot, Vec2 } from './types'

// Takımın hücum yönü çerçevesi: x̂ = rakip kaleye doğru artar.
// attackDir +1 ise saha koordinatı = hücum koordinatı; -1 ise her ikisi de aynalanır
// (böylece "sol kanat" hücum yönüne göre solda kalır).
const toPitch = (att: Vec2, d: 1 | -1): Vec2 => ({ x: att.x * d, y: att.y * d })
const toAttack = (p: Vec2, d: 1 | -1): Vec2 => ({ x: p.x * d, y: p.y * d })

// Slotun temel "ev pozisyonu" (hücum koordinatında)
export function homePositionAtt(slot: FormationSlot): Vec2 {
  return {
    x: (slot.depth - 0.5) * (HALF_LENGTH * 2),
    y: slot.width * HALF_WIDTH * 0.9,
  }
}

// Sistemin kalbi: ev pozisyonu + topa göre blok kayması.
// Topsuzken blok daralır ve geri çekilir, toplu takım genişler ve öne itilir.
export function targetPosition(
  slot: FormationSlot,
  attackDir: 1 | -1,
  ball: Vec2,
  hasPossession: boolean,
): Vec2 {
  const ballAtt = toAttack(ball, attackDir)

  if (slot.role === 'GK') {
    const advance = Math.min(1, Math.max(0, (ballAtt.x + HALF_LENGTH) / (HALF_LENGTH * 2)))
    const x = -HALF_LENGTH + 1.5 + advance * 8
    const y = Math.max(-6, Math.min(6, ballAtt.y * 0.25))
    return toPitch({ x, y }, attackDir)
  }

  const home = homePositionAtt(slot)
  // Topsuz blok kendi kalesine yaklaştıkça daralır: top kendi kutusuna
  // indiğinde bekler içeri kapanır, ceza sahası önü kalabalıklaşır
  const defDepth = Math.min(1, Math.max(0, (-ballAtt.x - 10) / 30))
  const widthScale = hasPossession ? 1.05 : 0.82 - 0.3 * defDepth
  const push = hasPossession ? 5 : -5

  let x = home.x + ballAtt.x * 0.3 + push
  const y = home.y * widthScale + ballAtt.y * (hasPossession ? 0.3 : 0.4)

  // Kompaktlık: topsuz takımın hatları topun derinliğine bağlanır.
  // maxDrop: topun gerisine ne kadar çökebilir (hat arası boşluk dar kalsın);
  // maxAhead: topun önünde ne kadar yüksekte kalabilir (top kendi sahasına
  // indiğinde orta saha yukarıda çakılı kalmasın, kutu önüne geri koşsun).
  if (!hasPossession) {
    // Forvetler de topsuzken geri döner (4-3-3 savunmada 4-5-1'e yaklaşır);
    // rakip sahada kamp kurup kontra bekleyemezler
    const maxDrop = slot.role === 'DF' ? 19 : slot.role === 'MF' ? 14 : 5
    const maxAhead = slot.role === 'DF' ? 4 : slot.role === 'MF' ? 12 : 15
    // Hat itme tavanı: top rakip sahanın derinindeyken blok topa kadar
    // sürüklenmez — savunma hattı orta sahayı pek geçmez, orta saha sınırlı
    // eşlik eder, yalnız forvetler yüksekte karşılar (full saha pres yok)
    const pressCap = slot.role === 'DF' ? 10 : slot.role === 'MF' ? 24 : 45
    x = Math.max(x, Math.min(ballAtt.x, pressCap) - maxDrop)
    x = Math.min(x, ballAtt.x + maxAhead)
  }

  return toPitch(
    {
      x: Math.max(-HALF_LENGTH + 2, Math.min(HALF_LENGTH - 2, x)),
      y: Math.max(-HALF_WIDTH + 1.5, Math.min(HALF_WIDTH - 1.5, y)),
    },
    attackDir,
  )
}
