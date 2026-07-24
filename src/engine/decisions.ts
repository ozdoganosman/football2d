import {
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
} from './constants'
import { composureFactor, dribbleSkill, shootSkill } from './attributes'
import { sharpness } from './stamina'
import { dist, distToSegment, norm, sub } from './vec'
import { BALANCED_TACTICS, type PlayerSim, type TeamTactics, type Vec2 } from './types'
import type { Rng } from './rng'

export type Decision =
  | { kind: 'pass'; targetId: number; score: number }
  | { kind: 'cross'; targetId: number; score: number }
  | { kind: 'shoot'; quality: number; score: number }
  | { kind: 'dribble'; dir: Vec2; score: number; takeOn?: boolean }
  | { kind: 'clear'; score: number }

// Hücum koordinatında pozisyon değeri: rakip kaleye ve merkeze yaklaştıkça artar,
// ceza sahası içi ekstra değerli. Pas seçeneklerinin "ilerletme" puanı buradan gelir.
export function positionValue(att: Vec2): number {
  const xNorm = (att.x + HALF_LENGTH) / (HALF_LENGTH * 2) // 0..1
  const central = 1 - Math.abs(att.y) / HALF_WIDTH
  let v = xNorm * 0.72 + xNorm * central * 0.28
  if (att.x > HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2) {
    v += 0.18
  }
  return v
}

export function shotQualityAt(
  shooter: PlayerSim,
  att: Vec2,
  opponents: PlayerSim[],
): number {
  const goal: Vec2 = { x: HALF_LENGTH, y: 0 }
  const d = dist(att, goal)
  if (d > 34) return 0
  const distFactor = Math.max(0, 1 - d / 40)
  const angleFactor = 1 - Math.min(1, Math.abs(att.y) / 24) * 0.8
  let nearest = 99
  for (const o of opponents) {
    if (o.sentOff || o.info.role === 'GK') continue
    nearest = Math.min(nearest, dist(o.pos, shooter.pos))
  }
  // Çarpışma tabanı 2.0 m: baskı ölçümü tabandan itibaren sayılır.
  // Taban 0.55: üstü kapatılan oyuncu da şutu "yine de dener" (uzaktan şutlar)
  const pressureFactor = 0.55 + 0.45 * Math.min(1, Math.max(0, (nearest - 1.8) / 5))
  // Yorgun bacak: bitiricilik düşer — yalnız 0.7 enerji altında (gerçekten
  // yorulmuş oyuncu), üstünde erken/orta maç kalitesi hiç etkilenmez
  const staminaFactor = shooter.energy >= 0.7 ? 1 : 0.8 + (0.2 * shooter.energy) / 0.7
  // Soğukkanlılık: bitirici baskı altında daha az harcar (taban nötr)
  return (
    distFactor *
    angleFactor *
    pressureFactor *
    staminaFactor *
    composureFactor(shooter.info.attributes) *
    shootSkill(shooter.info.attributes)
  )
}

const toAttack = (p: Vec2, d: 1 | -1): Vec2 => ({ x: p.x * d, y: p.y * d })

// Utility AI: her seçeneğe puan, en yükseği kazanır.
export function decide(
  carrier: PlayerSim,
  teammates: PlayerSim[],
  opponents: PlayerSim[],
  attackDir: 1 | -1,
  rng: Rng,
  counter = false, // top yeni kazanıldı: dikine oyna, hızlı bitir
  tactics: TeamTactics = BALANCED_TACTICS,
  // İkili paslaşma: bu id'li arkadaş az önce topu bu oyuncuya verip öne
  // fırladıysa (ver-kaç), geri pas (duvar pası tamamlama) öncelenir.
  returnToId?: number,
): Decision {
  const att = toAttack(carrier.pos, attackDir)
  const myValue = positionValue(att)
  const options: Decision[] = []

  let nearestOppDist = 99
  let nearestOpp: PlayerSim | null = null
  for (const o of opponents) {
    if (o.sentOff) continue
    const d = dist(o.pos, carrier.pos)
    if (d < nearestOppDist) {
      nearestOppDist = d
      nearestOpp = o
    }
  }
  const pressure = Math.max(0, 1 - nearestOppDist / 6) // 0 rahat, 1 üstünde adam var

  // Ofsayt çizgisi: sondan ikinci rakibin derinliği (orta çizgi alt sınır)
  const oppDepths = opponents
    .filter((o) => !o.sentOff)
    .map((o) => toAttack(o.pos, attackDir).x)
    .sort((a, b) => b - a)
  const offsideLine = Math.max(oppDepths[1] ?? 0, 0)

  // Rakip orta saha hattı (medyan): bloklar arası cebi tanımlar
  const oppMFx = opponents
    .filter((o) => !o.sentOff && o.info.role === 'MF')
    .map((o) => toAttack(o.pos, attackDir).x)
    .sort((a, b) => a - b)
  const mfLine = oppMFx.length ? oppMFx[Math.floor(oppMFx.length / 2)] : offsideLine - 20

  // Pas seçenekleri
  for (const m of teammates) {
    if (m === carrier || m.sentOff) continue
    const passLen = dist(carrier.pos, m.pos)
    if (passLen < 3 || passLen > 45) continue
    // Bariz ofsayttaki adama pas düşünülmez; çizgiye yakın sınır durumlar
    // denenir ve bazen bayrağa takılır (doğal ofsaytlar)
    const mAttX = toAttack(m.pos, attackDir).x
    if (mAttX > offsideLine + 1.2 && mAttX > att.x && mAttX > 0) continue

    let laneMin = 99
    let recvMin = 99
    for (const o of opponents) {
      if (o.sentOff) continue
      laneMin = Math.min(laneMin, distToSegment(o.pos, carrier.pos, m.pos))
      recvMin = Math.min(recvMin, dist(o.pos, m.pos))
    }
    const laneOpen = Math.min(1, laneMin / 9)
    const recvSpace = Math.min(1, recvMin / 8)
    const progress = positionValue(toAttack(m.pos, attackDir)) - myValue

    // Taktik mentalite: hücumcu ileri pası daha çok değerler (0 = dengeli)
    const progressW = (counter ? 0.6 : 0.48) + tactics.mentality * 0.08
    // Koşu yoluna pas: ileri koşan takım arkadaşı değerli bir hedeftir
    const runSpeed = (m.vel.x * attackDir + Math.abs(m.vel.y) * 0.3) / 7
    const runBonus = Math.max(0, Math.min(0.14, runSpeed * 0.14))
    let score =
      0.26 * laneOpen +
      0.2 * recvSpace +
      progressW * (0.55 + progress) +
      runBonus -
      0.09 +
      (passLen > 26 ? -0.02 * (passLen - 26) : 0) +
      (passLen < 10 ? -0.012 * (10 - passLen) : 0)
    // Bloklar arası bonus: iki hat arasındaki cepte BOŞTA gösteren adam
    // değerli bir hedeftir (markajlıysa bonus erir — recvSpace çarpanı)
    if (mAttX > mfLine + 1.5 && mAttX < offsideLine - 1) score += 0.08 * recvSpace
    // Ara pası: ofsayt çizgisine yapışıp İLERİ fırlayan adam derin topun
    // hedefidir — koşu yoluna pas onu hattın arkasına taşır
    if (mAttX > offsideLine - 3 && runSpeed > 0.5) score += 0.03
    // Duvar pası tamamlama: ver-kaç ortağı öne fırladıysa, geri pas onu
    // markajından sıyırıp ileride bulur (yol açıksa değerli)
    if (m.id === returnToId) score += 0.14 * laneOpen
    // Kaleci +1 adamdır: defanstan çıkışta geri pas meşru bir seçenek
    if (m.info.role === 'GK') score -= att.x < -15 ? 0.08 : 0.3
    // Baskı altındayken güvenli (açık) pas cazipleşir
    score += pressure * laneOpen * 0.12
    // Defanstan çıkışta genişe oyna: taşıyıcı kendi savunma üçte birindeyken
    // (att.x < -17.5), kendisinden belirgin daha geniş ve geride kalmayan
    // açık bir arkadaş cazipleşir. positionValue merkezi ödüllediği için
    // top hep içeriden çıkıyordu; bu terim onu dengeleyip topu kanattan
    // güvenli çıkarır. Yalnız build-up'a özel — genel oyunu kanada kaydırmaz.
    if (att.x < -HALF_LENGTH / 3) {
      const recvWide = Math.abs(m.pos.y)
      if (recvWide > Math.abs(carrier.pos.y) + 3 && mAttX > att.x - 4) {
        score += 0.1 * Math.min(1, recvWide / HALF_WIDTH) * laneOpen
      }
    }
    options.push({ kind: 'pass', targetId: m.id, score })
  }

  // Şut
  const quality = shotQualityAt(carrier, att, opponents)
  if (quality > 0.02) {
    const inBox =
      att.x > HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
    if (inBox || quality > 0.1) {
      // Taktik mentalite: hücumcu takım şutu biraz daha ister (0 = dengeli)
      const score = quality * 1.35 + (inBox ? 0.18 : 0) + tactics.mentality * 0.05
      options.push({ kind: 'shoot', quality, score })
    }
  }

  // Orta: son üçte birlik alanda kanattaysa ceza sahasındaki arkadaşa orta aç
  if (att.x > 24 && Math.abs(att.y) > 15) {
    let bestCross: PlayerSim | null = null
    let bestCrossScore = -1
    for (const m of teammates) {
      if (m === carrier || m.sentOff || m.info.role === 'GK') continue
      const mAtt = toAttack(m.pos, attackDir)
      if (mAtt.x < 28 || Math.abs(mAtt.y) > 15) continue
      let recvMin = 99
      for (const o of opponents) {
        if (!o.sentOff) recvMin = Math.min(recvMin, dist(o.pos, m.pos))
      }
      const s = Math.min(1, recvMin / 6)
      if (s > bestCrossScore) {
        bestCrossScore = s
        bestCross = m
      }
    }
    if (bestCross && bestCrossScore > 0.4) {
      // Yalnız kutuda gerçekten boş adam varsa orta cazip olsun
      const score = 0.3 + bestCrossScore * 0.22 - pressure * 0.12
      options.push({ kind: 'cross', targetId: bestCross.id, score })
    }
  }

  // Top taşıma: kaleye doğru öndeki boşluğa göre
  const goalDir = norm(sub({ x: HALF_LENGTH * attackDir, y: 0 }, carrier.pos))
  let aheadSpace = 99
  for (const o of opponents) {
    if (o.sentOff) continue
    const rel = sub(o.pos, carrier.pos)
    const along = rel.x * goalDir.x + rel.y * goalDir.y
    if (along > 0 && along < 14 && Math.abs(rel.x * goalDir.y - rel.y * goalDir.x) < 5) {
      aheadSpace = Math.min(aheadSpace, along)
    }
  }
  const space = Math.min(1, aheadSpace / 12)
  // Önünde (rakip kaleye bakan koridorda) alan olan oyuncu topu SÜRMEYE
  // meyillidir: puan alan-güdümlü — boş saha gören adam taşır, kalabalıkta
  // pas arar. Kontrada iştah daha da artar.
  const dribbleScore =
    0.4 +
    0.48 * space * dribbleSkill(carrier.info.attributes) +
    (counter ? 0.1 : 0) -
    pressure * 0.42
  options.push({ kind: 'dribble', dir: goalDir, score: dribbleScore })

  // Çalım (take-on): üstünde adam varken iyi top sürücü rakibin yanından
  // kesip onu geçmeyi dener — kendi ceza sahası önünde denemez
  if (nearestOpp && pressure > 0.35 && att.x > -HALF_LENGTH / 3) {
    const toOpp = sub(nearestOpp.pos, carrier.pos)
    // Rakibin hangi yanı boşsa oradan: goalDir x toOpp çapraz çarpım işareti
    const side = goalDir.x * toOpp.y - goalDir.y * toOpp.x > 0 ? -1 : 1
    const takeOnDir = norm({
      x: goalDir.x - goalDir.y * 1.1 * side,
      y: goalDir.y + goalDir.x * 1.1 * side,
    })
    const skill = dribbleSkill(carrier.info.attributes)
    const takeOnScore = 0.02 + 0.46 * skill + (counter ? 0.06 : 0) - pressure * 0.08
    options.push({ kind: 'dribble', dir: takeOnDir, score: takeOnScore, takeOn: true })
  }

  // Degaj: kendi üçte birlik alanında baskı altında. Açık kısa pas yoksa
  // kısa oynamayı ZORLAMA — uzuna git (çıkışın emniyet supabı)
  if (att.x < -HALF_LENGTH / 3) {
    let bestPassScore = -1
    for (const o of options) {
      if (o.kind === 'pass' && o.score > bestPassScore) bestPassScore = o.score
    }
    const depthFactor = Math.min(1, (-att.x - HALF_LENGTH / 3) / 20 + 0.4)
    const trapped = bestPassScore < 0.42 ? 0.12 : 0
    options.push({ kind: 'clear', score: pressure * depthFactor * 0.85 + trapped })
  }

  // Küçük gürültü determinist RNG'den — aynı seed aynı maç. Yorgun taşıyıcı
  // daha çok hata yapar: gürültü keskinlik düştükçe büyür (0.7 üstü etkisiz).
  const noise = 0.045 * (1 + (1 - sharpness(carrier.energy)) * 1.0)
  let best = options[0]
  let bestScore = -Infinity
  for (const opt of options) {
    const s = opt.score + rng.range(-noise, noise)
    if (s > bestScore) {
      bestScore = s
      best = opt
    }
  }
  return best
}
