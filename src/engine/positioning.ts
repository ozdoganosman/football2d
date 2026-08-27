import { HALF_LENGTH, HALF_WIDTH } from './constants'
import { BALANCED_TACTICS, type FormationSlot, type TeamTactics, type Vec2 } from './types'

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
  tactics: TeamTactics = BALANCED_TACTICS,
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
  // Toptayken takım ilerledikçe sahayı yayar: top kendi yarısındayken
  // varsayılan genişlik (1.05), rakip yarıya geçtikçe kanatlar tacı yaklaşıp
  // hücumda boşluk yaratır. attackProgress: top x=-10'da 0, x=+35'te 1.
  // Taktik genişlik: geniş ±%12 (0 = dengeli, etkisiz).
  const attackProgress = Math.min(1, Math.max(0, (ballAtt.x + 10) / 45))
  const widthScale =
    (hasPossession ? 1.05 + 0.2 * attackProgress : 0.82 - 0.3 * defDepth) *
    (1 + 0.12 * tactics.width)
  // Taktik mentalite: hücumcu blok öne, defansif geri (0 = dengeli, ±5 mevcut)
  const push = (hasPossession ? 5 : -5) + tactics.mentality * 4

  let x = home.x + ballAtt.x * 0.3 + push
  let y = home.y * widthScale + ballAtt.y * (hasPossession ? 0.3 : 0.4)

  // GÖREV OFSETLERİ (toplu oyunda takım kimliği): bindiren bek yükselir,
  // içe katan kanat yarı boşluğa girer, ön libero evde kalır, kutu golcüsü
  // yüksek yaşar. Topsuz herkes bloğa döner (görevler savunmayı bozamaz).
  if (slot.job && hasPossession) {
    switch (slot.job) {
      case 'wingback':
        x += 4
        y *= 1.12
        break
      case 'winger':
        y *= 1.18 // çizgiye yapış — genişlik yarat
        break
      case 'inside':
        x += 2.5
        y *= 0.62 // yarı boşluğa kat — şut açısı ara
        break
      case 'box_to_box':
        x += 3
        break
      case 'anchor':
        x -= 4
        y *= 0.85 // kontra sigortası: evde kal
        break
      case 'poacher':
        x += 2.5
        y *= 0.9 // çizgide yaşa
        break
      case 'stopper':
        x -= 1
        break
      default:
        break
    }
  }

  // Kompaktlık: topsuz takımın hatları topun derinliğine bağlanır.
  // maxDrop: topun gerisine ne kadar çökebilir (hat arası boşluk dar kalsın);
  // maxAhead: topun önünde ne kadar yüksekte kalabilir (top kendi sahasına
  // indiğinde orta saha yukarıda çakılı kalmasın, kutu önüne geri koşsun).
  if (!hasPossession) {
    // Forvetler de topsuzken geri döner (4-3-3 savunmada 4-5-1'e yaklaşır);
    // rakip sahada kamp kurup kontra bekleyemezler. Bindiren bek (3-5-2'de
    // MF rolündedir) topsuzken BEK disipliniyle savunur — kanadı boş bırakmaz
    const wb = slot.job === 'wingback'
    const maxDrop = slot.role === 'DF' || wb ? 19 : slot.role === 'MF' ? 14 : 5
    const maxAhead = slot.role === 'DF' ? 4 : wb ? 6 : slot.role === 'MF' ? 12 : 15
    // Hat itme tavanı: top rakip sahanın derinindeyken blok topa kadar
    // sürüklenmez — savunma hattı orta sahayı pek geçmez, orta saha sınırlı
    // eşlik eder, yalnız forvetler yüksekte karşılar (full saha pres yok).
    // Taktik pres: yüksek pres tavanı yukarı çeker (daha ileride karşılar).
    const pressBase =
      slot.role === 'DF' ? 10 : wb ? 13 : slot.role === 'MF' ? 24 : 45
    const pressCap = pressBase + tactics.press * 8
    x = Math.max(x, Math.min(ballAtt.x, pressCap) - maxDrop)
    x = Math.min(x, ballAtt.x + maxAhead)
    // Hat, topu izleyerek kale çizgisine kadar İNEMEZ: kutu önünde tutunur.
    // Taktik mentalite/hat: hücumcu daha yüksek hat (ofsayt tuzağı), defansif
    // daha derin tutunma (0 = dengeli, mevcut -HALF_LENGTH+12).
    if (slot.role === 'DF' || wb) x = Math.max(x, -HALF_LENGTH + 12 + tactics.mentality * 5)
  }

  return toPitch(
    {
      x: Math.max(-HALF_LENGTH + 2, Math.min(HALF_LENGTH - 2, x)),
      y: Math.max(-HALF_WIDTH + 1.5, Math.min(HALF_WIDTH - 1.5, y)),
    },
    attackDir,
  )
}
