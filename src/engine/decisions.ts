import {
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
} from './constants'
import { dribbleSkill, shootSkill } from './attributes'
import { dist, distToSegment, norm, sub } from './vec'
import type { PlayerSim, Vec2 } from './types'
import type { Rng } from './rng'

export type Decision =
  | { kind: 'pass'; targetId: number; score: number }
  | { kind: 'cross'; targetId: number; score: number }
  | { kind: 'shoot'; quality: number; score: number }
  | { kind: 'dribble'; dir: Vec2; score: number }
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
  if (d > 32) return 0
  const distFactor = Math.max(0, 1 - d / 38)
  const angleFactor = 1 - Math.min(1, Math.abs(att.y) / 24) * 0.8
  let nearest = 99
  for (const o of opponents) {
    if (o.sentOff || o.info.role === 'GK') continue
    nearest = Math.min(nearest, dist(o.pos, shooter.pos))
  }
  const pressureFactor = 0.5 + 0.5 * Math.min(1, nearest / 6)
  return distFactor * angleFactor * pressureFactor * shootSkill(shooter.info.attributes)
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
): Decision {
  const att = toAttack(carrier.pos, attackDir)
  const myValue = positionValue(att)
  const options: Decision[] = []

  let nearestOppDist = 99
  for (const o of opponents) {
    if (o.sentOff) continue
    nearestOppDist = Math.min(nearestOppDist, dist(o.pos, carrier.pos))
  }
  const pressure = Math.max(0, 1 - nearestOppDist / 6) // 0 rahat, 1 üstünde adam var

  // Ofsayt çizgisi: sondan ikinci rakibin derinliği (orta çizgi alt sınır)
  const oppDepths = opponents
    .filter((o) => !o.sentOff)
    .map((o) => toAttack(o.pos, attackDir).x)
    .sort((a, b) => b - a)
  const offsideLine = Math.max(oppDepths[1] ?? 0, 0)

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
    const laneOpen = Math.min(1, laneMin / 8)
    const recvSpace = Math.min(1, recvMin / 8)
    const progress = positionValue(toAttack(m.pos, attackDir)) - myValue

    const progressW = counter ? 0.58 : 0.42
    let score =
      0.26 * laneOpen +
      0.2 * recvSpace +
      progressW * (0.55 + progress) -
      0.09 +
      (passLen > 26 ? -0.02 * (passLen - 26) : 0) +
      (passLen < 10 ? -0.012 * (10 - passLen) : 0)
    if (m.info.role === 'GK') score -= 0.3
    // Baskı altındayken güvenli (açık) pas cazipleşir
    score += pressure * laneOpen * 0.12
    options.push({ kind: 'pass', targetId: m.id, score })
  }

  // Şut
  const quality = shotQualityAt(carrier, att, opponents)
  if (quality > 0.02) {
    const inBox =
      att.x > HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
    if (inBox || quality > 0.13) {
      const score = quality * 1.15 + (inBox ? 0.2 : 0)
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
  // İyi top sürücüler önlerinde alan varken taşımayı sever; kontrada daha da
  const dribbleScore =
    0.5 +
    0.3 * space * dribbleSkill(carrier.info.attributes) +
    (counter ? 0.08 : 0) -
    pressure * 0.42
  options.push({ kind: 'dribble', dir: goalDir, score: dribbleScore })

  // Degaj: kendi üçte birlik alanında baskı altında
  if (att.x < -HALF_LENGTH / 3) {
    const depthFactor = Math.min(1, (-att.x - HALF_LENGTH / 3) / 20 + 0.4)
    options.push({ kind: 'clear', score: pressure * depthFactor * 0.85 })
  }

  // Küçük gürültü determinist RNG'den — aynı seed aynı maç
  let best = options[0]
  let bestScore = -Infinity
  for (const opt of options) {
    const s = opt.score + rng.range(-0.045, 0.045)
    if (s > bestScore) {
      bestScore = s
      best = opt
    }
  }
  return best
}
