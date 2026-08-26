import {
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
} from './constants'
import { composureFactor, energyFactor, maxSpeed, shootSkill } from './attributes'
import { shotQualityAt } from './decisions'
import { targetPosition } from './positioning'
import { add, clampVec, dist, norm, scale, sub, vec } from './vec'
import type { MatchSim } from './engine'
import type { PlayerSim, RestartKind, Vec2 } from './types'

// Duran top alt sistemi: kurulum (dizilim hedefleri), yürütme (vuruş) ve
// restart faz adımı; gol sevinci koreografisi de burada (santra öncesi pencere).
// Tüm durum MatchSim üzerinde yaşar; buradaki fonksiyonlar o durumu işletir.

export function setupRestart(
  sim: MatchSim,
  kind: RestartKind,
  forTeam: number,
  spot: Vec2,
  timer: number,
): void {
  // Ölü top anı: oyuncu değişikliği penceresi açıldıysa değerlendir
  sim.trySubstitutions()
  const takerId = pickTaker(sim, kind, forTeam, spot)
  sim.engagerId = [-1, -1]
  sim.passIntent = null
  sim.oneTwo = null
  sim.pocketRun = { team: -1, ids: [-1, -1], lanes: [0, 0], modes: ['pocket', 'pocket'], until: 0, gamble: false }
  sim.phase = { kind: 'restart', restart: kind, forTeam, spot: { ...spot }, timer, takerId }
  sim.lastTouchTeam = forTeam
  sim.lastTouchId = takerId
  computeRestartTargets(sim)
}

export function pickTaker(sim: MatchSim, kind: RestartKind, forTeam: number, spot: Vec2): number {
  const mates = sim.active(forTeam)
  if (kind === 'goal_kick') return sim.keeperOf(forTeam)?.id ?? mates[0].id
  if (kind === 'penalty') {
    let best = mates[0]
    for (const m of mates) {
      if (m.info.role !== 'GK' && shootSkill(m.info.attributes) > shootSkill(best.info.attributes)) {
        best = m
      }
    }
    return best.id
  }
  if (kind === 'kickoff') {
    let best: PlayerSim | null = null
    for (const m of mates) {
      if (sim.slotOf(m).role !== 'FW') continue
      if (!best || dist(m.pos, spot) < dist(best.pos, spot)) best = m
    }
    return (best ?? mates[mates.length - 1]).id
  }
  // Uzun taç: özel atıcı gelir (kutuya fırlatır)
  if (kind === 'throw_in') {
    const lt = longThrowTaker(sim, spot, forTeam)
    if (lt >= 0) return lt
  }
  // taç / korner / serbest vuruş: en yakın saha oyuncusu
  let best: PlayerSim | null = null
  for (const m of mates) {
    if (m.info.role === 'GK') continue
    if (!best || dist(m.pos, spot) < dist(best.pos, spot)) best = m
  }
  return (best ?? mates[0]).id
}

// Serbest vuruş tipi (hücum çerçevesinde spot konumuna göre):
//  - shoot: kaleye yakın + merkezi → direkt şut tehdidi (duvar kurulur)
//  - cross: son üçte bir ama yan/uzak → kutuya orta (korner gibi)
//  - short: kendi yarısı / orta saha → kısa oyna
export function freeKickType(sim: MatchSim, spot: Vec2, forTeam: number): 'shoot' | 'cross' | 'short' {
  const att = sim.toAttack(spot, forTeam)
  const goalDist = dist(att, { x: HALF_LENGTH, y: 0 })
  if (goalDist < 25 && Math.abs(att.y) < 20) return 'shoot'
  if (att.x > HALF_LENGTH - 32 && goalDist < 46) return 'cross'
  return 'short'
}

// Uzun taç: rakip kale çizgisine yakın (hücum üçte biri) bir taçta, güçlü/uzun
// bir atıcı topu doğrudan ceza sahasına fırlatır (korner gibi tehdit).
// Uygun atıcının id'sini, yoksa -1 döner. RNG kullanmaz (üç yerde tutarlı).
export function longThrowTaker(sim: MatchSim, spot: Vec2, forTeam: number): number {
  const att = sim.toAttack(spot, forTeam)
  // Kale çizgisine ~30 m'den yakın taçlar (özel atıcı için erişilebilir mesafe)
  if (att.x < HALF_LENGTH - 30) return -1
  let bestId = -1
  let bestScore = -1
  for (const p of sim.active(forTeam)) {
    if (p.info.role === 'GK') continue
    const s = p.info.attributes.strength + p.info.attributes.height * 0.6
    if (s > bestScore) {
      bestScore = s
      bestId = p.id
    }
  }
  // Eşik: sıradan oyuncu ~19, özel uzun atıcı 23+ — yalnız gerçek bir
  // uzun atıcısı olan takım uzun taç kullanır
  return bestScore >= 22 ? bestId : -1
}

// Kutuya yığılma: hücumcuları yakın/uzak direk, penaltı noktası ve kutu
// önüne; savunmayı direkler + markaj + kutu önüne yerleştirir, kaleci
// çizgide. Korner ve kanattan serbest vuruşta ortak kullanılır.
// nearSide: hücum çerçevesinde topun geldiği taraf işareti (+1/-1).
export function loadBox(
  sim: MatchSim,
  targets: (Vec2 | null)[],
  attTeam: number,
  takerId: number,
  nearSide: number,
): void {
  const defTeam = 1 - attTeam
  const A = (x: number, y: number): Vec2 => sim.fromAttack({ x, y }, attTeam)
  // Hücumcu yerleşimi (hücum çerçevesi): en derin/hücumcu 5 oyuncu
  const attSpots: Vec2[] = [
    { x: HALF_LENGTH - 5.5, y: nearSide * 4.5 }, // yakın direk
    { x: HALF_LENGTH - 1.5, y: -nearSide * 5.5 }, // uzak direk
    { x: HALF_LENGTH - 10.5, y: nearSide * 0.5 }, // penaltı noktası
    { x: HALF_LENGTH - 6.5, y: -nearSide * 2 }, // merkez
    { x: HALF_LENGTH - 17, y: nearSide * 2.5 }, // kutu önü (ikinci top)
  ]
  const attackers = sim
    .active(attTeam)
    .filter((p) => p.id !== takerId && p.info.role !== 'GK')
    .sort((a, b) => sim.slotOf(b).depth - sim.slotOf(a).depth)
    .slice(0, attSpots.length)
  attackers.forEach((p, i) => {
    targets[p.id] = A(attSpots[i].x + sim.rng.range(-1, 1), attSpots[i].y + sim.rng.range(-1, 1))
  })
  // Kaleci çizgide, merkez/uzak direğe hafif
  const gk = sim.keeperOf(defTeam)
  if (gk) targets[gk.id] = A(HALF_LENGTH - 1.5, -nearSide * 1.5)
  // Savunma: yakın direk, uzak direk, 6 pas alanı markaj, kutu önü temizleyici
  const defSpots: Vec2[] = [
    { x: HALF_LENGTH - 1, y: nearSide * 3.4 }, // yakın direk
    { x: HALF_LENGTH - 1, y: -nearSide * 3.4 }, // uzak direk
    { x: HALF_LENGTH - 6, y: nearSide * 3 },
    { x: HALF_LENGTH - 6, y: -nearSide * 3.5 },
    { x: HALF_LENGTH - 11, y: nearSide * 1 }, // penaltı noktası bölgesi
    { x: HALF_LENGTH - 17, y: -nearSide * 0.5 }, // kutu önü (ikinci top)
  ]
  const defenders = sim
    .active(defTeam)
    .filter((p) => p.info.role !== 'GK')
    .sort((a, b) => sim.slotOf(a).depth - sim.slotOf(b).depth) // en defansif önce
    .slice(0, defSpots.length)
  defenders.forEach((p, i) => {
    targets[p.id] = A(defSpots[i].x + sim.rng.range(-1, 1), defSpots[i].y + sim.rng.range(-1, 1))
  })
}

// Kutuya orta: iç falso (yakın direk), dış falso (uzak direk) ya da sürülü
// top (penaltı noktası). Korner ve kanattan serbest vuruşta kullanılır.
export function crossIntoBox(
  sim: MatchSim,
  takerId: number,
  forTeam: number,
  spot: Vec2,
  nearSide: number,
): void {
  const A = (x: number, y: number): Vec2 => sim.fromAttack({ x, y }, forTeam)
  const attackers = sim.active(forTeam).filter((p) => p.id !== takerId && p.info.role !== 'GK')
  const roll = sim.rng.next()
  let landing: Vec2
  let curl: number
  const swing = sim.rng.range(1.6, 3.2)
  if (roll < 0.4) {
    // İç falso: yakın direğe, gole doğru kıvrılır
    landing = A(HALF_LENGTH - 5, nearSide * 4)
    curl = -Math.sign(spot.y || 1) * swing
  } else if (roll < 0.74) {
    // Dış falso: uzak direğe, çizgiden dışa açılır
    landing = A(HALF_LENGTH - 1.5, -nearSide * 5.5)
    curl = Math.sign(spot.y || 1) * swing
  } else {
    // Sürülü/düz: penaltı noktası bölgesine
    landing = A(HALF_LENGTH - 10.5, nearSide * sim.rng.range(-1.5, 1.5))
    curl = sim.rng.range(-0.8, 0.8)
  }
  landing = clampVec(landing, -HALF_LENGTH + 1, HALF_LENGTH - 1, -HALF_WIDTH + 1, HALF_WIDTH - 1)
  let target: PlayerSim | null = null
  let bd = 99
  for (const p of attackers) {
    const dd = dist(p.pos, landing)
    if (dd < bd) {
      bd = dd
      target = p
    }
  }
  const d = Math.max(1, dist(spot, landing))
  sim.ball = {
    kind: 'inFlight',
    from: { ...spot },
    to: landing,
    t: 0,
    duration: d / 16,
    flight: 'cross',
    byId: takerId,
    targetId: target?.id ?? null,
    hMax: 4 + d * 0.05,
    curl,
  }
  sim.lastTouchTeam = forTeam
  sim.lastTouchId = takerId
  sim.passesAttempted[forTeam]++
}

// Uzun taç fırlatması: kutuya düz ve hızlı (korner falsosu yok). Kutu
// yığılması loadBox ile kurulmuştur; top yakın direk/penaltı bölgesine iner.
export function longThrowIntoBox(sim: MatchSim, takerId: number, forTeam: number, spot: Vec2): void {
  const nearSide = Math.sign(sim.toAttack(spot, forTeam).y) || 1
  const landing = clampVec(
    sim.fromAttack(
      { x: HALF_LENGTH - sim.rng.range(6, 11), y: nearSide * sim.rng.range(1, 5) },
      forTeam,
    ),
    -HALF_LENGTH + 1,
    HALF_LENGTH - 1,
    -HALF_WIDTH + 1,
    HALF_WIDTH - 1,
  )
  const attackers = sim.active(forTeam).filter((p) => p.id !== takerId && p.info.role !== 'GK')
  let target: PlayerSim | null = null
  let bd = 99
  for (const p of attackers) {
    const dd = dist(p.pos, landing)
    if (dd < bd) {
      bd = dd
      target = p
    }
  }
  const d = Math.max(1, dist(spot, landing))
  sim.ball = {
    kind: 'inFlight',
    from: { ...spot },
    to: landing,
    t: 0,
    duration: d / 15, // düz ve hızlı hurdle
    flight: 'cross',
    byId: takerId,
    targetId: target?.id ?? null,
    hMax: 3 + d * 0.04, // korner ortasından daha alçak yay
    curl: 0,
  }
  sim.lastTouchTeam = forTeam
  sim.lastTouchId = takerId
  sim.passesAttempted[forTeam]++
}

export function computeRestartTargets(sim: MatchSim): void {
  if (sim.phase.kind !== 'restart') return
  const { restart, forTeam, spot, takerId } = sim.phase
  const targets: (Vec2 | null)[] = new Array(22).fill(null)
  targets[takerId] = { ...spot }

  if (restart === 'kickoff') {
    for (const p of sim.players) {
      if (p.sentOff) continue
      const d = sim.attackDir[p.teamIdx]
      const slot = sim.slotOf(p)
      const home = {
        x: Math.min((slot.depth - 0.5) * HALF_LENGTH * 2, -2.5),
        y: slot.width * HALF_WIDTH * 0.85,
      }
      targets[p.id] = { x: home.x * d, y: home.y * d }
    }
    targets[takerId] = { ...spot }
    // santrada destek oyuncusu
    const support = sim
      .active(forTeam)
      .filter((p) => p.id !== takerId && sim.slotOf(p).role === 'FW')
      .sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))[0]
    if (support) targets[support.id] = { x: -1.5 * sim.attackDir[forTeam], y: 1.5 }
  } else if (restart === 'corner') {
    // Yakın direk taraf işareti: kornerin geldiği yan (hücum çerçevesi)
    const nearSide = Math.sign(sim.toAttack(spot, forTeam).y) || 1
    loadBox(sim, targets, forTeam, takerId, nearSide)
  } else if (restart === 'free_kick') {
    const type = freeKickType(sim, spot, forTeam)
    const defTeam = 1 - forTeam
    const nearSide = Math.sign(sim.toAttack(spot, forTeam).y) || 1
    if (type === 'shoot') {
      // Direkt şut tehdidi: gol-top hattı üzerinde 9.15 m'de bir baraj kurulur.
      const dir = sim.attackDir[forTeam]
      const goal = { x: HALF_LENGTH * dir, y: 0 }
      const toGoal = norm(sub(goal, spot))
      const perp = { x: -toGoal.y, y: toGoal.x }
      const att = sim.toAttack(spot, forTeam)
      const wallN = Math.abs(att.y) < 10 ? 4 : 3
      // Baraj merkezi: 9.15 m ileride, yakın direk tarafına hafif kaydırılmış
      const wallCenter = add(add(spot, scale(toGoal, 9.15)), scale(perp, nearSide * dir * 0.9))
      const wallDefs = sim
        .active(defTeam)
        .filter((p) => p.info.role !== 'GK')
        .sort((a, b) => dist(a.pos, wallCenter) - dist(b.pos, wallCenter))
      for (let i = 0; i < Math.min(wallN, wallDefs.length); i++) {
        const off = (i - (wallN - 1) / 2) * 1.0
        targets[wallDefs[i].id] = add(wallCenter, scale(perp, off))
      }
      // Kaleci baraja karşı uzak direği kapatır (baraj yakın direği kapattı)
      const gk = sim.keeperOf(defTeam)
      if (gk) targets[gk.id] = sim.fromAttack({ x: HALF_LENGTH - 1.5, y: -nearSide * 2 }, forTeam)
      // Birkaç hücumcu kutu içinde/önünde toparlanır (dönen top / ikinci top)
      const boxSpots: Vec2[] = [
        { x: HALF_LENGTH - 9, y: nearSide * 6 },
        { x: HALF_LENGTH - 9, y: -nearSide * 6 },
        { x: HALF_LENGTH - 16, y: 0 },
      ]
      const boxAtt = sim
        .active(forTeam)
        .filter((p) => p.id !== takerId && p.info.role !== 'GK')
        .sort((a, b) => sim.slotOf(b).depth - sim.slotOf(a).depth)
        .slice(0, boxSpots.length)
      boxAtt.forEach((p, i) => {
        targets[p.id] = sim.fromAttack(boxSpots[i], forTeam)
      })
    } else if (type === 'cross') {
      // Kanattan/uzaktan: kutuya orta düzeni (korner gibi)
      loadBox(sim, targets, forTeam, takerId, nearSide)
    }
    // 'short': özel hedef yok — formasyon şeklinden çıkışa bırakılır
  } else if (restart === 'goal_kick') {
    // Defanstan çıkış şekli: bekler geniş ve alçak, stoperler açık, bir orta
    // saha iner — kısa oyun seçenekleri doğar (baskı yoksa kısa, varsa uzun)
    for (const p of sim.active(forTeam)) {
      if (p.id === takerId) continue
      const slot = sim.slotOf(p)
      if (slot.role === 'DF') {
        const wide = Math.abs(slot.width) >= 0.5
        targets[p.id] = sim.fromAttack(
          { x: -HALF_LENGTH + (wide ? 14 : 9), y: slot.width * (wide ? 26 : 14) },
          forTeam,
        )
      } else if (slot.role === 'MF' && Math.abs(slot.width) < 0.4) {
        targets[p.id] = sim.fromAttack({ x: -HALF_LENGTH + 22, y: slot.width * 10 }, forTeam)
      }
    }
    // Kural: kale vuruşunda rakipler ceza sahasına giremez. Kutu içindeki
    // rakip oyuncular kutu kenarının hemen dışına çıkarılır; kaleci topu
    // vurunca (executeRestart → open) yeniden serbestçe hareket ederler.
    const oppTeam = 1 - forTeam
    const boxEdgeX = -HALF_LENGTH + PENALTY_AREA_DEPTH
    for (const o of sim.active(oppTeam)) {
      const att = sim.toAttack(o.pos, forTeam)
      if (att.x < boxEdgeX && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2) {
        const y = Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, att.y))
        targets[o.id] = sim.fromAttack({ x: boxEdgeX + 1.5, y }, forTeam)
      }
    }
  } else if (restart === 'throw_in') {
    if (takerId === longThrowTaker(sim, spot, forTeam)) {
      // Uzun taç: kutuya yığılma (korner düzeni)
      const nearSide = Math.sign(sim.toAttack(spot, forTeam).y) || 1
      loadBox(sim, targets, forTeam, takerId, nearSide)
    } else {
      // Taç: yakın iki arkadaş boşa çıkar (biri çizgi boyu ileri, biri içeri)
      const nearSide = Math.sign(spot.y) || 1
      const near = sim
        .active(forTeam)
        .filter((p) => p.id !== takerId && p.info.role !== 'GK')
        .sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))
        .slice(0, 2)
      const dir = sim.attackDir[forTeam]
      if (near[0]) targets[near[0].id] = { x: spot.x + dir * 6, y: nearSide * (HALF_WIDTH - 6) }
      if (near[1]) targets[near[1].id] = { x: spot.x - dir * 2, y: nearSide * (HALF_WIDTH - 12) }
    }
  } else if (restart === 'penalty') {
    const defTeam = 1 - forTeam
    const gk = sim.keeperOf(defTeam)
    const goalX = HALF_LENGTH * sim.attackDir[forTeam]
    if (gk) targets[gk.id] = { x: goalX - sim.attackDir[forTeam] * 0.8, y: 0 }
    // Penaltıcı topun ~5 m gerisinde bekler (koşu başlangıcı); son anda
    // topa koşar (bkz. stepRestart penaltı koşusu)
    targets[takerId] = {
      x: spot.x - 5 * sim.attackDir[forTeam],
      y: spot.y,
    }
    // Diğerleri: penaltı yayının gerisinde (kutu + nokta dışında), dönen topa
    // hazır — hücum/savunma dönüşümlü dizilir
    const boxEdgeX = HALF_LENGTH - PENALTY_AREA_DEPTH
    let k = 0
    for (const p of sim.players) {
      if (p.sentOff || p.id === takerId || (gk && p.id === gk.id)) continue
      const arcY = ((k % 6) - 2.5) * 3.4
      targets[p.id] = sim.fromAttack({ x: boxEdgeX - 2.5, y: arcY }, forTeam)
      k++
    }
  }
  sim.restartTargets = targets
}

export function snapToRestartTargets(sim: MatchSim): void {
  for (const p of sim.players) {
    if (p.sentOff) continue
    const t = sim.restartTargets[p.id]
    if (t) p.pos = { ...t }
    else {
      const slot = sim.slotOf(p)
      p.pos = targetPosition(slot, sim.attackDir[p.teamIdx], vec(0, 0), p.teamIdx === 0)
    }
  }
}

// Gol sevinci penceresini kur: golcü köşe bayrağına koşar, takım arkadaşları
// onu kovalar; santra bu pencereden sonra başlar (temiz reset ile).
export function startCelebration(sim: MatchSim, team: number, scorerId: number): void {
  sim.celebrateTeam = team
  sim.celebrateScorerId = scorerId
  sim.celebrateSnapped = false
  sim.celebrateUntil = sim.tick + 55 // ~5.5 sn seremonik kutlama
  const dir = sim.attackDir[team]
  const ref = scorerId >= 0 ? sim.players[scorerId].pos : vec(dir * 30, 0)
  // Golün atıldığı taraftaki köşe bayrağına doğru koşu
  sim.celebrateCorner = {
    x: dir * (HALF_LENGTH - 4),
    y: Math.sign(ref.y || (sim.tick % 2 ? 1 : -1)) * (HALF_WIDTH - 4),
  }
}

// Kutlama adımı: golcü köşeye, takım arkadaşları golcüye koşar; gol yiyen
// takım yavaşça durur (hayal kırıklığı). Santra bittiğinde temiz reset olur.
export function stepCelebration(sim: MatchSim, dt: number): void {
  const scorer = sim.celebrateScorerId >= 0 ? sim.players[sim.celebrateScorerId] : null
  for (const p of sim.active()) {
    if (p.id === sim.downedId && sim.tick < sim.downedUntil) {
      p.vel = vec(0, 0)
      continue
    }
    if (p.teamIdx === sim.celebrateTeam) {
      const target = scorer && p.id !== scorer.id ? scorer.pos : sim.celebrateCorner
      sim.movePlayer(p, target, maxSpeed(p.info.attributes) * 0.8, dt, 8)
    } else {
      // gol yiyen: yavaşlayıp durur
      p.vel = scale(p.vel, 0.82)
      p.pos = add(p.pos, scale(p.vel, dt))
    }
  }
  sim.resolveCollisions()
}

// --- restart yürütme ---

export function executeRestart(sim: MatchSim): void {
  if (sim.phase.kind !== 'restart') return
  const { restart, forTeam, spot, takerId } = sim.phase
  sim.phase = { kind: 'open' }
  sim.restartTargets = []
  sim.celebrateUntil = -1 // kutlama durumu temizlenir
  const taker = sim.players[takerId]
  // Kullanıcı zaten yürüyerek geldi; en fazla küçük bir düzeltme olur
  if (dist(taker.pos, spot) > 2.5) taker.pos = { ...spot }

  if (restart === 'kickoff') {
    const mates = sim.active(forTeam).filter((p) => p.id !== takerId)
    mates.sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))
    sim.pushEvent('kickoff', forTeam, takerId)
    if (mates[0]) sim.launchPass(takerId, mates[0].id, 'pass', true)
    else sim.possess(takerId)
    return
  }

  if (restart === 'corner') {
    const nearSide = Math.sign(sim.toAttack(spot, forTeam).y) || 1
    const attackers = sim.active(forTeam).filter((p) => p.id !== takerId && p.info.role !== 'GK')
    // Kısa korner: ~%12 — yakın arkadaşa yerden pas, oyun açık devam eder
    if (sim.rng.chance(0.12) && attackers.length) {
      sim.possess(takerId, spot)
      const near = attackers.sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))[0]
      sim.launchPass(takerId, near.id, 'pass', true)
      return
    }
    // Orta: iç/dış falso ya da sürülü top (crossIntoBox içinde çeşitlenir)
    crossIntoBox(sim, takerId, forTeam, spot, nearSide)
    return
  }

  if (restart === 'penalty') {
    // Top beyaz noktaya konur: executeRestart faz'ı 'open'a çevirdiği için
    // launchShot'taki from = ballPos() artık spot'u değil topun konumunu
    // okur — noktaya koymazsak şut faul yerinden (yan taraftan) çıkar.
    sim.ball = { kind: 'rolling', pos: { ...spot }, vel: vec(0, 0), controllerId: -1 }
    // Soğukkanlı penaltıcı beyaz noktadan daha güvenli: composure çarpanı
    const quality =
      (0.68 + shootSkill(taker.info.attributes) * 0.25) * composureFactor(taker.info.attributes)
    sim.launchShot(takerId, Math.min(0.96, quality), true)
    return
  }

  if (restart === 'free_kick') {
    const type = freeKickType(sim, spot, forTeam)
    const att = sim.toAttack(spot, forTeam)
    if (type === 'shoot') {
      // Baraj kuruldu: top ya barajı aşar (kalite biraz düşer, falso yardımcı)
      // ya da baraja çarpar (blok → dönen top / korner)
      if (sim.rng.chance(0.16)) {
        sim.shots[forTeam]++
        // Baraja çarpan direkt frikik de bir şuttur: kaleciye hiç varmadığı
        // için düşük sabit xG (geometrik model bloklu şutu değerlendirmez)
        const fkXg = 0.04
        sim.xg[forTeam] += fkXg
        sim.pendingXg = fkXg
        sim.pushEvent('shot_blocked', forTeam, takerId)
        const dir = sim.attackDir[forTeam]
        // Baraja çarpan top öne sekip dönen top olur
        sim.looseBall(
          add(spot, scale(vec(dir, 0), 8)),
          { x: dir * sim.rng.range(-0.5, 0.5), y: sim.rng.range(-1, 1) },
          sim.rng.range(2, 5),
        )
        sim.lastTouchTeam = forTeam
        sim.lastTouchId = takerId
        return
      }
      const q = shotQualityAt(taker, att, sim.active(1 - forTeam)) * 0.82
      if (q > 0.03) {
        sim.launchShot(takerId, q)
        return
      }
    } else if (type === 'cross') {
      // Kanattan/uzaktan serbest vuruş: kutuya orta
      const nearSide = Math.sign(att.y) || 1
      crossIntoBox(sim, takerId, forTeam, spot, nearSide)
      return
    }
    // 'short': aşağıdaki kısa pas mantığına düşer
  }

  if (restart === 'throw_in' && takerId === longThrowTaker(sim, spot, forTeam)) {
    // Uzun taç: kutuya fırlat (kutu loadBox ile yığıldı)
    sim.pushEvent(
      'throw_in',
      forTeam,
      takerId,
      -1,
      `Uzun taç! ${sim.teams[forTeam].name} topu doğrudan ceza sahasına fırlatıyor`,
    )
    longThrowIntoBox(sim, takerId, forTeam, spot)
    return
  }

  // taç / kale vuruşu / pas restartı: en uygun yakın takım arkadaşına pas
  sim.possess(takerId, spot)
  const mates = sim.active(forTeam).filter((p) => p.id !== takerId)
  let best: PlayerSim | null = null
  let bestScore = -Infinity
  for (const m of mates) {
    const dm = dist(m.pos, spot)
    if (dm > (restart === 'goal_kick' ? 55 : 30)) continue
    let recvMin = 99
    for (const o of sim.active(1 - forTeam)) recvMin = Math.min(recvMin, dist(o.pos, m.pos))
    const score = Math.min(1, recvMin / 8) - dm / 60
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  // Taç, kale vuruşu ve santradan ofsayt olmaz
  if (best) sim.launchPass(takerId, best.id, 'pass', restart !== 'free_kick')
  else sim.launchClearance(takerId)
}

export function stepRestart(sim: MatchSim, dt: number): void {
  if (sim.phase.kind !== 'restart') return
  // Gol sevinci: santradan önce kısa kutlama; kutlama boyunca restart timer'ı
  // dondurulur. Kutlama bitince temiz reset (herkes kendi yarısına) + kısa
  // bir bekleme sonrası santra vuruşu — böylece santra net görünür.
  if (sim.tick < sim.celebrateUntil) {
    stepCelebration(sim, dt)
    return
  }
  if (sim.celebrateUntil >= 0 && !sim.celebrateSnapped) {
    snapToRestartTargets(sim)
    sim.celebrateSnapped = true
    sim.phase.timer = 10 // reset sonrası kısa bekleme, sonra vuruş
  }
  // Düdük anı: kısa bir donma — faul/penaltı algılanabilir olur
  if (sim.tick < sim.freezeUntil) {
    sim.phase.timer--
    return
  }
  // Penaltı koşusu: son ~12 tick'te penaltıcı topa doğru koşar (seremoni)
  if (sim.phase.restart === 'penalty' && sim.phase.timer < 12) {
    sim.restartTargets[sim.phase.takerId] = { ...sim.phase.spot }
  }
  for (const p of sim.active()) {
    if (p.id === sim.downedId && sim.tick < sim.downedUntil) {
      p.vel = vec(0, 0)
      continue
    }
    const t = sim.restartTargets[p.id]
    let target =
      t ??
      targetPosition(
        sim.slotOf(p),
        sim.attackDir[p.teamIdx],
        sim.phase.spot,
        p.teamIdx === sim.phase.forTeam,
      )
    if (p.id !== sim.phase.takerId && p.info.role !== 'GK') {
      target = add(target, sim.separation(p))
    }
    const spd = maxSpeed(p.info.attributes) * energyFactor(p.energy) * 0.85
    sim.movePlayer(p, target, spd, dt)
  }
  // Kural: kale vuruşunda rakipler ceza sahasına giremez — kutuya giren
  // rakip her tick kenara itilir (top vurulunca faz 'open' olur, serbest kalırlar)
  if (sim.phase.restart === 'goal_kick') {
    const forTeam = sim.phase.forTeam
    const boxEdgeX = -HALF_LENGTH + PENALTY_AREA_DEPTH
    for (const o of sim.active(1 - forTeam)) {
      const att = sim.toAttack(o.pos, forTeam)
      if (att.x < boxEdgeX && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2) {
        o.pos = sim.fromAttack({ x: boxEdgeX + 0.5, y: att.y }, forTeam)
        o.vel = vec(0, 0)
      }
    }
  }
  sim.resolveCollisions()
  sim.phase.timer--
  if (sim.phase.timer <= 0) {
    // Kullanıcı topun başına gelene kadar bekle (makul bir üst sınırla)
    const taker = sim.players[sim.phase.takerId]
    if (dist(taker.pos, sim.phase.spot) < 2.6 || sim.phase.timer < -60) {
      executeRestart(sim)
    }
  }
}
