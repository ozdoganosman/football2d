import {
  HALF_GOAL,
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_AREA_WIDTH,
  TICK_DT,
} from './constants'
import {
  aerialSkill,
  controlSkill,
  dribbleSkill,
  gkSkill,
  headingSkill,
  interceptSkill,
  passErrorRate,
  passSpeed,
  shootSkill,
  tackleSkill,
} from './attributes'
import { sharpness } from './stamina'
import { attemptTackle } from './duels'
import { planShot } from './shooting'
import { decide, shotQualityAt, type Decision } from './decisions'
import { xgGeometric } from './xg'
import { add, dist, norm, scale, sub, vec } from './vec'
import type { MatchSim } from './engine'
import type { PlayerSim, Vec2 } from './types'

// Toplu oyun alt sistemi: yuvarlanan/uçan topun tick adımları, taşıyıcının
// eylemleri (pas, şut, degaj, top sürme), uçuş varışlarının çözümü ve gol.

// İkili paslaşma kurulumu: açık oyunda kısa, ileri/yana bir pas baskı
// altında verildiyse, pası atan oyuncu "ver-kaç" görevini üstlenir —
// topu verir vermez markörünün boş yanından öne fırlar (movePlayers
// pencere boyunca onu ileri koşturur, alıcı geri pası önceler).
export function maybeSetupOneTwo(sim: MatchSim, by: PlayerSim, to: PlayerSim): void {
  if (by.info.role === 'GK' || to.info.role === 'GK') return
  if (dist(by.pos, to.pos) > 20) return // yalnız kısa duvar pası
  const byAtt = sim.toAttack(by.pos, by.teamIdx)
  const toAtt = sim.toAttack(to.pos, by.teamIdx)
  if (byAtt.x < -8) return // kendi savunmasında ver-kaç kurulmaz
  if (toAtt.x < byAtt.x - 4) return // geri pasla ver-kaç olmaz
  // Baskı altında: yakında rakip varsa duvar pası onu geçmek için anlamlı
  let press = 99
  for (const o of sim.active(1 - by.teamIdx)) press = Math.min(press, dist(o.pos, by.pos))
  if (press > 7) return
  sim.oneTwo = { passerId: by.id, receiverId: to.id, team: by.teamIdx, until: sim.tick + 24 }
}

// --- uçuş başlatma ---

export function launchPass(
  sim: MatchSim,
  byId: number,
  targetId: number,
  flight: 'pass' | 'cross' = 'pass',
  exemptOffside = false,
): void {
  const by = sim.players[byId]
  const to = sim.players[targetId]
  const from = { ...sim.ballPos() }
  // Koşu yoluna pas: hedef, alıcının ayağı değil — mevcut koşusunun uçuş
  // süresi kadar önü. Koşan adam topu adım aralığında, hız kesmeden alır.
  const d0raw = dist(from, to.pos)
  const flightT = d0raw / passSpeed(by.info.attributes)
  let lead = scale(to.vel, flightT * 0.85)
  const leadLen = Math.hypot(lead.x, lead.y)
  if (leadLen > 12) lead = scale(lead, 12 / leadLen)
  if (leadLen < 1) lead = scale(norm(sub(to.pos, from)), 1.2) // duran adama ayağa
  const d0 = d0raw
  // Uzun paslarda ve baskı altında hata payı büyür
  let err = passErrorRate(by.info.attributes) * (1 + d0 / 40)
  // Yorgun ayak: hata payı büyür — yalnız 0.7 enerji altında (erken/orta
  // maçta taze oyuncunun pas kalitesi hiç etkilenmez)
  if (by.energy < 0.7) err *= 1 + (0.7 - by.energy) * 0.9
  let passerPressure = 99
  for (const o of sim.active(1 - by.teamIdx)) {
    passerPressure = Math.min(passerPressure, dist(o.pos, by.pos))
  }
  if (passerPressure < 5) err *= 1 + (1 - passerPressure / 5) * 0.7
  // Kısa hazırlık pasları teknik olarak kolaydır — hata payı düşük
  if (d0 < 14) err *= 0.5
  // Bozuk pas: baskı ve mesafeyle olasılığı artar (rahat kısa pasta nadir)
  const mishitP = 0.015 + (passerPressure < 3 ? 0.05 : 0) + (d0 > 25 ? 0.03 : 0)
  if (sim.rng.chance(mishitP)) err *= 2.5
  const target = {
    x: to.pos.x + lead.x + sim.rng.range(-1, 1) * err * d0,
    y: to.pos.y + lead.y + sim.rng.range(-1, 1) * err * d0,
  }
  // Ofsayt kontrolü (pas anındaki pozisyona göre)
  let offside = false
  if (!exemptOffside) {
    const line = sim.offsideLine(by.teamIdx)
    const recvAttX = sim.toAttack(to.pos, by.teamIdx).x
    const ballAttX = sim.toAttack(from, by.teamIdx).x
    offside = recvAttX > line + 0.15 && recvAttX > ballAttX && recvAttX > 0
  }

  const d = Math.max(1, dist(from, target))
  // Uzun paslar ve ortalar havadan gider (bloğun üstünden aşar)
  const lofted = flight === 'cross' || d0 > 27

  if (!lofted) {
    // YERDEN PAS = topa gerçek vuruş. Top fiziksel yuvarlanır: yol boyu
    // yavaşlar, hafif falso yayı çizer; araya girme saf geometridir.
    const dir = norm(sub(target, from))
    const vArr = 5.5 + d * 0.08 // hedefte kalmasını istediğimiz hız
    let firmness = sim.rng.range(0.9, 1.12)
    if (passerPressure < 3) firmness += 0.1 // baskıda fazla vurma eğilimi
    const v0 = Math.sqrt(vArr * vArr + 2 * 1.5 * d) * firmness
    sim.ball = {
      kind: 'rolling',
      pos: { ...from },
      vel: scale(dir, v0),
      controllerId: -1,
      curl: sim.rng.range(-0.3, 0.3),
    }
    sim.passIntent = { byId, targetId, team: by.teamIdx, offside, tick: sim.tick }
    sim.lastTouchTeam = by.teamIdx
    sim.lastTouchId = byId
    // Yalnız kaleci: elle kapma kontrolsüz/hep başarılı olduğundan, dar
    // alanda kendi kısa pasını aynı an geri kapayıp döngüye girebiliyordu
    // (bkz. stepRolling). Saha oyuncularında zaten bir kontrol zarı var,
    // dokunuşu doğal bir varyans; onlara dokunmuyoruz.
    if (by.info.role === 'GK') {
      sim.justKickedId = byId
      sim.justKickedTick = sim.tick
    }
    sim.passesAttempted[by.teamIdx]++
    sim.pushEvent('pass', by.teamIdx, byId, targetId)
    return
  }

  // BALİSTİK havadan pas: gerçek yerçekimiyle uçar, inişte seker, hız
  // sürekliliğiyle yuvarlanmaya devreder. Pas hızı sabit değil (doğal varyans).
  sim.aerialBall(
    from,
    target,
    d / (passSpeed(by.info.attributes) * sim.rng.range(0.85, 1.1)),
    flight,
    byId,
    targetId,
    offside,
    0,
    Math.min(7, 2 + d * 0.08),
  )
  // Havadan pasta da niyet tutulur (iniş sonrası kovalama + tamamlama
  // sayacı); ofsayt düdüğü ilk yer temasında/dokunuşta çalınır
  sim.passIntent = { byId, targetId, team: by.teamIdx, offside: false, tick: sim.tick }
  sim.lastTouchTeam = by.teamIdx
  sim.lastTouchId = byId
  sim.passesAttempted[by.teamIdx]++
  sim.pushEvent('pass', by.teamIdx, byId, targetId)
}

export function launchShot(
  sim: MatchSim,
  byId: number,
  quality: number,
  isPenalty = false,
  headed = false,
): void {
  const by = sim.players[byId]
  const from = { ...sim.ballPos() }
  const dir = sim.attackDir[by.teamIdx]
  const keeper = sim.keeperOf(1 - by.teamIdx)

  // Şut anında blok kontrolü — sekmelerle (deflection): blok çoğunlukla topu
  // durdurur; bazen auta sekip KORNER olur, nadiren kaleciyi çalıp devrilerek
  // GOL olur (şutörün golü), çok nadiren kendi ağına döner (kendi kalesine gol).
  const goal = { x: HALF_LENGTH * dir, y: 0 }
  for (const o of sim.active(1 - by.teamIdx)) {
    if (o.info.role === 'GK') continue
    const toGoal = dist(from, goal)
    const oDist = dist(o.pos, from)
    if (oDist < 3.5 && dist(o.pos, goal) < toGoal && sim.rng.chance(0.3)) {
      sim.shots[by.teamIdx]++
      // El: blok bazen kolla olur → penaltı/serbest vuruş (nadir)
      if (sim.rng.chance(0.02)) {
        sim.handleHandball(o)
        return
      }
      // Bloklanan şut kaleciye varmaz: düşük xG (sekme golü nadir)
      const blockXg = 0.02
      sim.xg[by.teamIdx] += blockXg
      sim.pendingXg = blockXg
      const roll = sim.rng.next()
      const nearOwnGoal = dist(o.pos, goal) < 13 // savunmacı kendi kalesine çok yakın
      if (roll < 0.015) {
        // Sekme içeri girdi: kaleye çok yakın savunmacıda bazen kendi
        // ağına, aksi halde kaleciyi çalarak şutörün golü (ikisi de nadir)
        if (nearOwnGoal && sim.rng.chance(0.3)) scoreOwnGoal(sim, o.id)
        else scoreGoal(sim, byId)
        return
      }
      sim.pushEvent('shot_blocked', by.teamIdx, byId)
      if (roll < 0.3) {
        // Sekip kale çizgisinin dışına → korner
        sim.corners[by.teamIdx]++
        sim.pushEvent('corner', by.teamIdx)
        const spot = {
          x: dir * (HALF_LENGTH - 0.5),
          y: Math.sign(o.pos.y || 1) * (HALF_WIDTH - 0.5),
        }
        sim.setupRestart('corner', by.teamIdx, spot, 90)
        return
      }
      // Normal blok: oyunda kalan sekme
      sim.looseBall(o.pos, sub(o.pos, from), sim.rng.range(2, 5))
      sim.lastTouchTeam = o.teamIdx
      sim.lastTouchId = o.id
      return
    }
  }

  // Bloklanmadı: GEOMETRİK ÇÖZÜM. Şut hızı → uçuş süresi → nişan + yürütme
  // hatası + kalecinin gerçek konumu/refleksiyle kesişme testi (planShot).
  // Şut hızı vuruş gücüne/kaliteye bağlı: zayıf şut ~17-20 m/s, güçlü ve
  // isabetli şut ~30-33 m/s.
  const skill = shootSkill(by.info.attributes)
  // Kafa vuruşu ayak şutundan çok daha yavaştır (~9-15 m/s) — kaleciye
  // gerçekçi reaksiyon penceresi doğar
  const shotSpeed = headed
    ? Math.max(8, Math.min(16, 8 + skill * 4 + quality * 3 + sim.rng.range(-1, 1)))
    : Math.max(15, Math.min(33, 15 + skill * 13 + quality * 4 + sim.rng.range(-2, 2)))
  // Baskı: en yakın saha rakibi (şut sapmasını büyütür)
  let nearestOpp = 99
  for (const o of sim.active(1 - by.teamIdx)) {
    if (o.info.role === 'GK') continue
    nearestOpp = Math.min(nearestOpp, dist(o.pos, by.pos))
  }
  const pressure01 = Math.max(0, Math.min(1, 1 - Math.max(0, nearestOpp - 1.8) / 5))
  const dPlane = Math.max(1, Math.hypot(goal.x - from.x, from.y))
  const flightT = dPlane / shotSpeed

  const plan = planShot({
    from,
    dir,
    goalX: goal.x,
    shooter: by,
    keeper,
    quality,
    pressure01,
    flightT,
    rng: sim.rng,
    isPenalty,
    headed,
  })
  sim.pendingShot = plan.outcome

  // Beklenen gol: aynı geometrinin deterministik integrali (xg.ts). Penaltı
  // sabit ~0.76. Penaltı serisi ayrı tiebreak — maç istatistiğine yazılmaz.
  if (!sim.soActive) {
    const xg = isPenalty
      ? 0.76
      : xgGeometric({ from, goalX: goal.x, shooter: by, keeper, quality, pressure01, flightT, headed })
    sim.xg[by.teamIdx] += xg
    sim.pendingXg = xg
  }

  // Top gerçek kesişme noktasına uçar: aut görünür şekilde dışarı, kurtarış
  // gerçekten kalecinin uzandığı noktada biter (sonuç ve görüntü aynı gerçek)
  const target = { x: HALF_LENGTH * dir, y: plan.targetY }
  const d = Math.max(1, dist(from, target))
  sim.ball = {
    kind: 'inFlight',
    from,
    to: target,
    t: 0,
    duration: d / shotSpeed,
    flight: 'shot',
    byId,
    targetId: null,
    shotQuality: quality,
    curl: sim.rng.range(-0.9, 0.9),
    zTo: plan.targetZ,
  }
  sim.lastTouchTeam = by.teamIdx
  sim.lastTouchId = byId
  if (!sim.soActive) sim.shots[by.teamIdx]++ // seri şutları maç istatistiğine girmez

  // Kaleci şutu okur ve GERÇEK kesişme noktasına atlar (çerçeve içine
  // kısıtlı): iyi kaleci / zayıf şut daha hızlı tepki alır
  if (keeper) {
    const gk = gkSkill(keeper.info.attributes)
    const reactionTicks = Math.max(
      1,
      Math.round((0.12 + (1 - gk) * 0.2 + quality * 0.1) / TICK_DT),
    )
    const diveY = Math.max(-HALF_GOAL + 0.3, Math.min(HALF_GOAL - 0.3, plan.targetY))
    sim.keeperDive = {
      keeperId: keeper.id,
      to: { x: goal.x - dir * 0.4, y: diveY },
      readyTick: sim.tick + reactionTicks,
    }
  } else {
    sim.keeperDive = null
  }
}

export function launchClearance(sim: MatchSim, byId: number): void {
  const by = sim.players[byId]
  const from = { ...sim.ballPos() }
  const dir = sim.attackDir[by.teamIdx]
  // Degaj uzun gider: baskıyı gerçekten rahatlatır
  const target = {
    x: Math.min(HALF_LENGTH - 3, Math.max(-HALF_LENGTH + 3, from.x + dir * sim.rng.range(26, 48))),
    y: Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, from.y + sim.rng.range(-16, 16))),
  }
  const d = Math.max(1, dist(from, target))
  sim.aerialBall(from, target, d / 19, 'clearance', byId, null, false, 0, 3 + d * 0.07)
  sim.lastTouchTeam = by.teamIdx
  sim.lastTouchId = byId
}

// --- olay çözümleri ---

export function scoreGoal(sim: MatchSim, byId: number): void {
  const by = sim.players[byId]
  sim.score[by.teamIdx]++
  sim.shotsOnTarget[by.teamIdx]++
  sim.pushEvent('goal', by.teamIdx, byId)
  sim.addStoppage(20)
  const conceding = 1 - by.teamIdx
  sim.startCelebration(by.teamIdx, byId)
  sim.setupRestart('kickoff', conceding, vec(0, 0), 45)
}

// Kendi kalesine gol: skoru RAKİP takıma yazar, olayı topu kendi ağına
// sokan savunmacıya bağlar. Santrayı gol yiyen (savunmacının) takımı kullanır.
export function scoreOwnGoal(sim: MatchSim, defenderId: number): void {
  const def = sim.players[defenderId]
  const scoringTeam = 1 - def.teamIdx
  sim.score[scoringTeam]++
  sim.pushEvent('own_goal', scoringTeam, defenderId)
  sim.addStoppage(20)
  sim.startCelebration(scoringTeam, -1) // kendi kalesine golde belirli golcü yok
  sim.setupRestart('kickoff', def.teamIdx, vec(0, 0), 45)
}

export function outOfBounds(sim: MatchSim, pos: Vec2): void {
  // Ölü top süreleri gerçekçi: taç ~7 sn, kale vuruşu/korner ~9 sn.
  // Maç saati restart fazında da işlediğinden bu, topun oyunda kaldığı
  // süreyi gerçek maç seviyesine (~60-70 dk) çeker — pas/şut hacmini
  // doğal yoldan normalleştiren ana mekanizma.
  // Taç
  if (Math.abs(pos.y) > HALF_WIDTH) {
    const forTeam = 1 - sim.lastTouchTeam
    const spot = {
      x: Math.max(-HALF_LENGTH + 1, Math.min(HALF_LENGTH - 1, pos.x)),
      y: Math.sign(pos.y) * (HALF_WIDTH - 0.3),
    }
    sim.pushEvent('throw_in', forTeam)
    sim.setupRestart('throw_in', forTeam, spot, 125)
    return
  }
  // Kale çizgisi
  const side = Math.sign(pos.x) // hangi kale çizgisi
  const defTeam = sim.attackDir[0] === side ? 1 : 0 // o kaleyi savunan takım
  const attTeam = 1 - defTeam
  if (sim.lastTouchTeam === defTeam) {
    // savunan takım çıkardı → korner
    sim.corners[attTeam]++
    sim.pushEvent('corner', attTeam)
    const spot = { x: side * (HALF_LENGTH - 0.5), y: Math.sign(pos.y || 1) * (HALF_WIDTH - 0.5) }
    sim.setupRestart('corner', attTeam, spot, 110)
  } else {
    sim.pushEvent('goal_kick', defTeam)
    const spot = sim.fromAttack({ x: -HALF_LENGTH + 5.5, y: 0 }, defTeam)
    sim.setupRestart('goal_kick', defTeam, spot, 135)
  }
}

export function resolveShotArrival(sim: MatchSim): void {
  if (sim.ball.kind !== 'inFlight') return
  const { byId } = sim.ball
  const by = sim.players[byId]
  const outcome = sim.pendingShot ?? { kind: 'missed' as const }
  sim.pendingShot = null
  sim.keeperDive = null
  const keeper = sim.keeperOf(1 - by.teamIdx)

  // Penaltı serisi: sonucu seri mantığına yönlendir (maç skoru/santra yok)
  if (sim.soActive) {
    sim.resolveShootoutKick(byId, outcome.kind === 'goal')
    return
  }

  if (outcome.kind === 'goal') {
    scoreGoal(sim, byId)
    return
  }
  if (outcome.kind === 'woodwork') {
    // Direğe/üst direğe çarptı: çoğunlukla sahaya döner (dönen top), bazen
    // dışarı seker (korner/kale vuruşu), çok nadir çarpıp içeri girer.
    sim.pushEvent('woodwork', by.teamIdx, byId)
    const dir = sim.attackDir[by.teamIdx]
    const r = sim.rng.next()
    if (r < 0.06) {
      scoreGoal(sim, byId) // direkten sekip içeri
      return
    }
    if (r < 0.4) {
      // dışarı seker → korner
      sim.corners[by.teamIdx]++
      sim.pushEvent('corner', by.teamIdx)
      const spot = {
        x: dir * (HALF_LENGTH - 0.5),
        y: Math.sign(sim.ball.to.y || 1) * (HALF_WIDTH - 0.5),
      }
      sim.setupRestart('corner', by.teamIdx, spot, 90)
      return
    }
    // Sahaya döner: kale önünde tehlikeli dönen top
    const dropPos = {
      x: sim.ball.to.x - dir * sim.rng.range(3, 8),
      y: sim.ball.to.y + sim.rng.range(-5, 5),
    }
    sim.looseBall(dropPos, { x: -dir, y: sim.rng.range(-0.6, 0.6) }, sim.rng.range(2, 4))
    sim.lastTouchTeam = by.teamIdx
    sim.lastTouchId = byId
    return
  }
  if (outcome.kind === 'missed') {
    sim.pushEvent('shot_missed', by.teamIdx, byId)
    const defTeam = 1 - by.teamIdx
    // Bazen savunmadan sekip kornere çıkar
    if (sim.rng.chance(0.42)) {
      sim.corners[by.teamIdx]++
      sim.pushEvent('corner', by.teamIdx)
      const dir = sim.attackDir[by.teamIdx]
      const spot = {
        x: dir * (HALF_LENGTH - 0.5),
        y: Math.sign(sim.ball.to.y || 1) * (HALF_WIDTH - 0.5),
      }
      sim.setupRestart('corner', by.teamIdx, spot, 90)
      return
    }
    const spot = sim.fromAttack({ x: -HALF_LENGTH + 5.5, y: 0 }, defTeam)
    sim.pushEvent('goal_kick', defTeam)
    sim.setupRestart('goal_kick', defTeam, spot, 135)
    return
  }
  sim.shotsOnTarget[by.teamIdx]++
  if (outcome.kind === 'parried_corner') {
    sim.pushEvent('shot_saved', by.teamIdx, byId, keeper?.id ?? -1)
    sim.corners[by.teamIdx]++
    sim.pushEvent('corner', by.teamIdx)
    const dir = sim.attackDir[by.teamIdx]
    const ballY = sim.ball.to.y
    const spot = { x: dir * (HALF_LENGTH - 0.5), y: Math.sign(ballY || 1) * (HALF_WIDTH - 0.5) }
    sim.setupRestart('corner', by.teamIdx, spot, 90)
    return
  }
  // saved
  sim.pushEvent('shot_saved', by.teamIdx, byId, keeper?.id ?? -1)
  if (keeper && outcome.kind === 'saved' && outcome.held) {
    sim.possess(keeper.id)
  } else if (keeper) {
    // öne çeldi → ceza sahasında tehlikeli boş top
    const dir = sim.attackDir[by.teamIdx]
    const dropPos = {
      x: sim.ball.to.x - dir * sim.rng.range(5, 10),
      y: sim.ball.to.y + sim.rng.range(-6, 6),
    }
    sim.looseBall(dropPos, { x: -dir, y: sim.rng.range(-0.5, 0.5) }, sim.rng.range(1, 3))
    sim.lastTouchTeam = keeper.teamIdx
    sim.lastTouchId = keeper.id
  } else {
    sim.looseBall(sim.ball.to, { x: -sim.attackDir[by.teamIdx], y: 0 }, 2)
  }
}

// Açık oyundan (şut zinciri dışında) kale çizgisini direkler arasından geçen
// top: son dokunan hücum ediyorsa GOL, savunuyorsa KENDİ KALESİNE GOL.
// Karambol golleri, olimpik korner ve talihsiz sekmeler buradan doğar.
export function scoreFromOpenBall(sim: MatchSim, sideSign: number): void {
  const attTeam = sim.attackDir[0] === sideSign ? 0 : 1
  if (sim.lastTouchTeam === attTeam) {
    // Açık toptan gol de bir "şut girişimi" sayılır (istatistik tutarlılığı:
    // gol ≤ isabetli şut ≤ şut değişmezi korunur); küçük sabit xG eklenir
    if (!sim.soActive) {
      sim.shots[attTeam]++
      sim.xg[attTeam] += 0.25
      sim.pendingXg = 0.25
    }
    scoreGoal(sim, sim.lastTouchId)
  } else {
    scoreOwnGoal(sim, sim.lastTouchId)
  }
}

// Ofsayt düdüğü (havadan pas): bayrak pas anında kalkmıştı, düdük topun
// ilk yer temasında/etkileşiminde çalar — koşu tamamlanır, doğal görünür
function whistleOffside(sim: MatchSim, b: Extract<MatchSim['ball'], { kind: 'inFlight' }>): void {
  const passTeam = sim.players[b.byId].teamIdx
  const defTeam = 1 - passTeam
  sim.offsides[passTeam]++
  sim.pushEvent('offside', passTeam, b.targetId ?? b.byId)
  const spot = {
    x: Math.max(-HALF_LENGTH + 2, Math.min(HALF_LENGTH - 2, b.to.x)),
    y: Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, b.to.y)),
  }
  sim.setupRestart('free_kick', defTeam, spot, 55)
}

// Kafa vuruşunu çöz: kazanan bölgeye göre kafayı kaleye vurur (hücum
// bölgesi), degaj eder (savunma bölgesi) ya da öne aşırtır (orta saha).
// Kafa vuruşu ayakla vuruştan daha zordur; kalite düşük, sapma yüksektir.
export function resolveHeader(sim: MatchSim, winner: PlayerSim, pos: Vec2): void {
  const team = winner.teamIdx
  const att = sim.toAttack(winner.pos, team)
  // Pas niyeti kafa dokunuşunda çözülür: hedeflenen takım kafalıyorsa pas
  // TAMAMLANDI sayılır (orta → kafa golü tamamlanmış ortadır), rakip
  // kafalarsa araya girmedir — muhasebe possess() ile tutarlı
  const pi = sim.passIntent
  if (pi) {
    sim.passIntent = null
    if (team === pi.team) {
      sim.passesCompleted[pi.team]++
    } else if (winner.id !== pi.byId) {
      sim.pushEvent('interception', team, winner.id)
    }
  }
  sim.lastTouchTeam = team
  sim.lastTouchId = winner.id
  // Top kafa vuruşu noktasına yerleşir; ilgili başlatıcı buradan oynar
  sim.ball = { kind: 'rolling', pos: { ...pos }, vel: vec(0, 0), controllerId: winner.id }
  sim.pushEvent('header', team, winner.id)

  // HÜCUM BÖLGESİ (rakip kaleye yakın + merkezi): kafayla şut
  const inShootZone =
    att.x > HALF_LENGTH - 18 && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2 + 2
  if (inShootZone) {
    // Kafa vuruşu kalitesi kafa/boy becerisine bağlı: iyi kafa vuran
    // (uzun santrafor) tehlikeli, kötüsü zararsız
    const headF = 0.4 + headingSkill(winner.info.attributes) * 0.4
    const q = shotQualityAt(winner, att, sim.active(1 - team)) * headF
    if (q > 0.02) {
      launchShot(sim, winner.id, q, false, true)
      return
    }
  }
  // SAVUNMA BÖLGESİ (kendi kaleye yakın): kafayla degaj. Baskı altındaki
  // savunma kafası bazen kontrolsüz çıkar ve kendi kale çizgisinin
  // gerisine gider → korner (gerçek maçların başlıca korner kaynağı)
  if (att.x < -HALF_LENGTH + 24) {
    if (att.x < -HALF_LENGTH + 14 && sim.rng.chance(0.24)) {
      const attTeam = 1 - team
      sim.corners[attTeam]++
      sim.pushEvent('corner', attTeam)
      const side = sim.attackDir[attTeam]
      const spot = {
        x: side * (HALF_LENGTH - 0.5),
        y: Math.sign(winner.pos.y || 1) * (HALF_WIDTH - 0.5),
      }
      sim.lastTouchTeam = team
      sim.lastTouchId = winner.id
      sim.setupRestart('corner', attTeam, spot, 110)
      return
    }
    launchClearance(sim, winner.id)
    return
  }
  // ORTA SAHA: öne aşırtma (kafayla ileri arkadaşa) ya da boşluğa indirme
  let best: PlayerSim | null = null
  let bestScore = -Infinity
  for (const m of sim.active(team)) {
    if (m.id === winner.id) continue
    const mAtt = sim.toAttack(m.pos, team)
    const d = dist(m.pos, winner.pos)
    if (mAtt.x < att.x - 2 || d < 6 || d > 28) continue
    const score = mAtt.x - att.x - d * 0.2
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  if (best) {
    launchPass(sim, winner.id, best.id, 'pass', true)
  } else {
    // İleri boşluğa indir: kafa knock-down
    const dir = sim.attackDir[team]
    sim.looseBall(pos, { x: dir, y: sim.rng.range(-0.5, 0.5) }, sim.rng.range(4, 7))
  }
}

// Yerdeki topun fizik adımı. Top HER ZAMAN kendi hız/sürtünmesiyle
// yuvarlanır; kontrolcü ona yetişip ayağına aldığında oynar. Top sürme =
// topa gerçek vuruşlar yapıp kovalamak — top asla oyuncuya geri "çekilmez".
export function stepRolling(sim: MatchSim, dt: number): void {
  if (sim.ball.kind !== 'rolling') return
  const b = sim.ball

  // Fizik: yuvarlanma direnci sabit yavaşlamadır (a = 1.5 m/s², çim) —
  // pas yol boyu doğal biçimde yavaşlar. Falso (curl) hafif yay çizdirir.
  b.pos = add(b.pos, scale(b.vel, dt))
  const v = Math.hypot(b.vel.x, b.vel.y)
  if (v > 1e-6) {
    const v2 = Math.max(0, v - 1.5 * dt)
    if (v2 < 0.15) {
      b.vel = vec(0, 0)
    } else {
      let nx = b.vel.x / v
      let ny = b.vel.y / v
      if (b.curl) {
        // dik yönde küçük ivme: yön hafifçe döner
        const turn = (b.curl / Math.max(2, v)) * dt
        const cos = Math.cos(turn)
        const sin = Math.sin(turn)
        const rx = nx * cos - ny * sin
        const ry = nx * sin + ny * cos
        nx = rx
        ny = ry
      }
      b.vel = { x: nx * v2, y: ny * v2 }
    }
  }

  if (Math.abs(b.pos.y) > HALF_WIDTH || Math.abs(b.pos.x) > HALF_LENGTH) {
    // Direkler arasından çizgiyi geçen YERDEKİ top: karambol golü (sekme,
    // kötü ilk dokunuş, çelinen top...) — şut zinciri olmadan da gol olur
    if (Math.abs(b.pos.x) > HALF_LENGTH && Math.abs(b.pos.y) < HALF_GOAL) {
      scoreFromOpenBall(sim, Math.sign(b.pos.x))
      return
    }
    outOfBounds(sim, b.pos)
    return
  }

  if (b.controllerId >= 0 && sim.players[b.controllerId].sentOff) b.controllerId = -1

  // Boştaki top: kapma kontesti (kontrol testiyle; hızlı top zor durur).
  // Yarıçap 1.3: çarpışma tabanı (2.0) topun iki yanında kilitlenen iki
  // oyuncunun da erişebilmesine izin verir — kura çözer.
  if (b.controllerId < 0) {
    const ballSpeed = Math.hypot(b.vel.x, b.vel.y)
    // Yumuşak varış kolay, sıcak gelen pas zor kontrol edilir
    const pickupDifficulty = ballSpeed < 4 ? 0 : (ballSpeed - 4) * 0.09
    // Aktif oynayan (pasın alıcısı, topa giden görevliler, son dokunan)
    // tam kapma menziline sahiptir; yol kenarında DİKİLEN oyuncu ancak
    // bacak uzatabilir (0.8) — pasif dikilme her pası otomatik çalmasın.
    // Ayrıca pası atan, topu ayağının dibinden anında geri kapamasın
    // (justKicked penceresi — özellikle kaleci: elle kapma hep başarılı).
    const piNow = sim.passIntent
    const contenders = sim.active().filter((p) => {
      if (p.id === sim.justKickedId && sim.tick - sim.justKickedTick < 4) return false
      const activeOnBall =
        (piNow && p.id === piNow.targetId) ||
        p.id === sim.engagerId[0] ||
        p.id === sim.engagerId[1] ||
        p.id === sim.lastTouchId
      return dist(p.pos, b.pos) < (activeOnBall ? 1.3 : 0.8)
    })
    if (contenders.length === 1) {
      sim.receiveBall(contenders[0].id, pickupDifficulty)
    } else if (contenders.length > 1) {
      let total = 0
      const weights = contenders.map((p) => {
        const w = interceptSkill(p.info.attributes)
        total += w
        return w
      })
      let roll = sim.rng.next() * total
      for (let i = 0; i < contenders.length; i++) {
        roll -= weights[i]
        if (roll <= 0) {
          sim.receiveBall(contenders[i].id, pickupDifficulty + 0.2)
          break
        }
      }
    }
    return
  }

  const carrier = sim.players[b.controllerId]
  const opponents = sim.active(1 - carrier.teamIdx)
  const dBall = dist(carrier.pos, b.pos)

  // Kontrol kaybı: top kontrolcüden koptu ve bir rakip topa bariz daha yakın
  if (dBall > 2.4) {
    for (const o of opponents) {
      if (dist(o.pos, b.pos) < dBall - 0.6) {
        b.controllerId = -1
        return
      }
    }
  }

  // Müdahale denemeleri
  const outcome = attemptTackle(carrier, opponents, sim.rng)
  if (outcome.kind === 'foul') {
    const tackler = sim.players[outcome.tacklerId]
    // AVANTAJ: faul hücum bölgesinde oldu ve topu taşıyan kontrolünü
    // koruyorsa (top hâlâ onda) hakem oyunu durdurmaz — top ilerideki
    // takımda kalır, faul ve kart yine sayılır. Aksi halde düdük çalar.
    // Avantaj yalnız GERÇEKTEN umut verici bir atakta oynatılır: taşıyıcı
    // ileri bölgede ve önünde AÇIK KOŞU YOLU varsa (kaleye giden koridorda
    // engelleyen savunmacı yoksa). Aksi halde duran top (frikik) daha
    // değerli olduğundan hakem düdüğü çalar. Gerçekte maç başına birkaç kez.
    const attX = sim.toAttack(carrier.pos, carrier.teamIdx).x
    let clearAhead = true
    const gDir = norm(sub(vec(HALF_LENGTH * sim.attackDir[carrier.teamIdx], 0), carrier.pos))
    for (const o of opponents) {
      if (o.id === tackler.id || o.info.role === 'GK') continue
      const rel = sub(o.pos, carrier.pos)
      const along = rel.x * gDir.x + rel.y * gDir.y
      const perp = Math.abs(rel.x * gDir.y - rel.y * gDir.x)
      if (along > 0 && along < 9 && perp < 4.5) {
        clearAhead = false
        break
      }
    }
    if (attX > 12 && clearAhead && sim.rng.chance(0.6)) {
      sim.fouls[tackler.teamIdx]++
      sim.rollFoulCard(tackler)
      tackler.tackleCooldown = 2.5 // faul yapan geri çekilir, hemen dalamaz
      sim.pushEvent('advantage', carrier.teamIdx, outcome.tacklerId, carrier.id)
      // oyun devam eder: taşıyıcı topu korur (return yok)
    } else {
      tackler.tackleCooldown = 3
      sim.handleFoul(outcome.tacklerId, carrier.id)
      return
    }
  } else if (outcome.kind === 'won') {
    const tackler = sim.players[outcome.tacklerId]
    tackler.tackleCooldown = 1.5
    sim.pushEvent('tackle', tackler.teamIdx, tackler.id, carrier.id)
    if (outcome.toFeet) {
      sim.possess(tackler.id)
    } else {
      sim.looseBall(
        b.pos,
        { x: sim.rng.range(-1, 1), y: sim.rng.range(-1, 1) },
        sim.rng.range(2, 5),
      )
      sim.lastTouchTeam = tackler.teamIdx
      sim.lastTouchId = tackler.id
    }
    return
  }
  if (outcome.kind === 'beaten') {
    sim.players[outcome.tacklerId].tackleCooldown = 0.8
  }

  // Karar zamanı mı? Yalnız top ayaktayken (oyuncu fiziksel topa yetişmişse)
  const ballSpeedNow = Math.hypot(b.vel.x, b.vel.y)
  if (dBall < 1.6 && ballSpeedNow < 3.5 && sim.tick >= sim.nextDecisionTick) {
    const mates = sim.active(carrier.teamIdx)
    if (carrier.info.role === 'GK') {
      gkDistribute(sim, carrier, mates, opponents)
      return
    }
    // Kontra penceresi: top yeni kazanıldıysa hızlı ve dikine oyna
    const counter =
      sim.tick - sim.lastTurnover.tick < 30 && carrier.teamIdx === sim.lastTurnover.team
    // Ver-kaç geri pası: bu oyuncu az önce bir duvar pasının alıcısıysa
    // ortağına geri pas öncelenir
    const returnToId =
      sim.oneTwo &&
      sim.oneTwo.team === carrier.teamIdx &&
      sim.oneTwo.receiverId === carrier.id &&
      sim.tick < sim.oneTwo.until
        ? sim.oneTwo.passerId
        : undefined
    const decision: Decision = decide(
      carrier,
      mates,
      opponents,
      sim.attackDir[carrier.teamIdx],
      sim.rng,
      counter,
      sim.effTactics[carrier.teamIdx],
      returnToId,
    )
    // Karar temposu: gerçek futbol ritmi — taşıyıcı topu saniyelerce tutar,
    // pas makineli tüfek gibi çıkmaz (pas/maç sayısını gerçekçi tutan ayar)
    sim.nextDecisionTick = sim.tick + (counter ? 10 : 14)
    if (decision.kind === 'pass') {
      if (returnToId === decision.targetId) {
        // Bu pas duvar pasını TAMAMLIYOR: yeni bir ver-kaç kurma, yoksa
        // iki oyuncu sonsuz geri-pas ping-pongu'na girebilir
        sim.oneTwo = null
      } else {
        maybeSetupOneTwo(sim, carrier, sim.players[decision.targetId])
      }
      launchPass(sim, carrier.id, decision.targetId)
      return
    }
    if (decision.kind === 'cross') {
      launchPass(sim, carrier.id, decision.targetId, 'cross')
      return
    }
    if (decision.kind === 'shoot') {
      launchShot(sim, carrier.id, decision.quality)
      return
    }
    if (decision.kind === 'clear') {
      launchClearance(sim, carrier.id)
      return
    }
    // dribble: yön belirle, hafif gürültü; sürüşe kararlı bağlan —
    // oyuncu topu gerçekten taşısın, yarım adımda vazgeçmesin
    const noisy = norm({
      x: decision.dir.x + sim.rng.range(-0.25, 0.25),
      y: decision.dir.y + sim.rng.range(-0.35, 0.35),
    })

    // Çalım: en yakın rakiple anlık birebir kontesti — kazanırsa adam
    // ekarte olur, kaybederse top gider (bedava geçiş yok)
    if (decision.kind === 'dribble' && decision.takeOn) {
      let opp: PlayerSim | null = null
      let od = 3
      for (const o of opponents) {
        const dd = dist(o.pos, carrier.pos)
        if (dd < od) {
          od = dd
          opp = o
        }
      }
      if (opp) {
        const drb = dribbleSkill(carrier.info.attributes)
        const tck = tackleSkill(opp.info.attributes)
        const pWin = Math.max(0.25, Math.min(0.7, 0.5 + (drb - tck) * 0.6))
        if (sim.rng.chance(pWin)) {
          opp.tackleCooldown = Math.max(opp.tackleCooldown, 1.3) // ekarte
        } else if (sim.rng.chance(0.06)) {
          sim.handleFoul(opp.id, carrier.id) // çalım faul kazandırdı
          return
        } else {
          opp.tackleCooldown = Math.max(opp.tackleCooldown, 0.5)
          sim.pushEvent('tackle', opp.teamIdx, opp.id, carrier.id)
          if (sim.rng.chance(0.5)) {
            sim.possess(opp.id)
          } else {
            sim.looseBall(
              carrier.pos,
              { x: sim.rng.range(-1, 1), y: sim.rng.range(-1, 1) },
              sim.rng.range(2, 5),
            )
            sim.lastTouchTeam = opp.teamIdx
            sim.lastTouchId = opp.id
          }
          return
        }
      }
    }

    // VURUŞ: topa gerçek impuls — top öne yuvarlanır, oyuncu kovalar,
    // yetişince tekrar oynar. Ağır dokunuş topu fazla açar (kontrolü
    // kötü oyuncuda daha sık) ve rakip araya girebilir.
    // Yön sürekliliği: ardışık dokunuşlar önceki sürüş yönüyle harmanlanır
    // (zikzak değil kavis) — çalım kesmesi bilinçli KESKİN kalır
    const prevDir = carrier.dribbleDir
    const kickDir =
      decision.kind === 'dribble' && !decision.takeOn && prevDir
        ? norm({ x: prevDir.x * 0.55 + noisy.x * 0.45, y: prevDir.y * 0.55 + noisy.y * 0.45 })
        : noisy
    carrier.dribbleDir = kickDir
    const heavyP = 0.14 * (1.5 - controlSkill(carrier.info.attributes))
    const kick = sim.rng.chance(heavyP) ? sim.rng.range(6.5, 8.5) : sim.rng.range(4.2, 6)
    b.vel = scale(kickDir, kick)
    sim.lastTouchTeam = carrier.teamIdx
    sim.lastTouchId = carrier.id
    sim.nextDecisionTick = sim.tick + 5
  }
}

export function gkDistribute(
  sim: MatchSim,
  gk: PlayerSim,
  mates: PlayerSim[],
  opponents: PlayerSim[],
): void {
  sim.nextDecisionTick = sim.tick + 5
  let best: PlayerSim | null = null
  let bestScore = -Infinity
  for (const m of mates) {
    if (m.id === gk.id) continue
    const d = dist(m.pos, gk.pos)
    if (d < 8 || d > 48) continue
    let recvMin = 99
    for (const o of opponents) recvMin = Math.min(recvMin, dist(o.pos, m.pos))
    const score = Math.min(1, recvMin / 9) - d / 100
    if (score > bestScore) {
      bestScore = score
      best = m
    }
  }
  // Takım açılana kadar bekle: iyi bir kısa pas açısı henüz yoksa, kaleciye
  // baskı yoksa ve bekleme tavanı dolmadıysa topu tut — bekler/kanatlar
  // genişledikçe (build-up şekli oturdukça) açı doğar. Bir tavan var ki
  // sonsuza dek beklemesin (dolunca ya pas ya degaj).
  if (sim.tick < sim.gkHoldUntil && bestScore < 0.55) {
    let nearestOpp = 99
    for (const o of opponents) nearestOpp = Math.min(nearestOpp, dist(o.pos, gk.pos))
    let minY = 99
    let maxY = -99
    for (const m of mates) {
      if (m.id === gk.id) continue
      minY = Math.min(minY, m.pos.y)
      maxY = Math.max(maxY, m.pos.y)
    }
    const teamWidth = maxY - minY
    // Baskı yok + takım henüz yeterince geniş açılmadı → tut, yeniden yokla
    if (nearestOpp > 12 && teamWidth < 48) {
      sim.nextDecisionTick = sim.tick + 3
      return
    }
  }
  if (best && bestScore > 0.25) launchPass(sim, gk.id, best.id)
  else launchClearance(sim, gk.id)
}

export function stepInFlight(sim: MatchSim, dt: number): void {
  if (sim.ball.kind !== 'inFlight') return
  const b = sim.ball
  b.t += dt / b.duration

  if (b.flight === 'shot') {
    const sPos = sim.flightPos(b)
    if (b.t >= 1 || Math.abs(sPos.x) >= HALF_LENGTH - 0.1) {
      resolveShotArrival(sim)
    }
    return
  }

  // BALİSTİK ADIM: yerçekimi + (ilk sekmeye kadar) falso ivmesi
  if (!b.bPos || !b.bVel || b.bZ === undefined || b.bVz === undefined) return
  if (b.curlA && b.curlAx && (b.bounces ?? 0) === 0) {
    b.bVel.x += b.curlAx.x * b.curlA * dt
    b.bVel.y += b.curlAx.y * b.curlA * dt
  }
  b.bVz -= 9.81 * dt
  b.bZ += b.bVz * dt
  b.bPos.x += b.bVel.x * dt
  b.bPos.y += b.bVel.y * dt
  const pos = b.bPos

  // Saha dışı / kale çizgisi: direkler arasından ve üst direğin altından
  // geçen top GOLDÜR (olimpik korner, içeri yağan orta/degaj — nadir, gerçek)
  if (Math.abs(pos.y) > HALF_WIDTH || Math.abs(pos.x) > HALF_LENGTH) {
    if (b.offside) {
      whistleOffside(sim, b)
      return
    }
    if (Math.abs(pos.x) > HALF_LENGTH && Math.abs(pos.y) < HALF_GOAL && b.bZ < 2.44) {
      scoreFromOpenBall(sim, Math.sign(pos.x))
      return
    }
    outOfBounds(sim, pos)
    return
  }

  // İNİŞ: ilk yer temasında ofsayt düdüğü; değilse sekme → alçalınca
  // hız sürekliliğiyle yuvarlanmaya devir (yapay çıkış hızı yok)
  if (b.bZ <= 0 && b.bVz < 0) {
    if (b.offside) {
      whistleOffside(sim, b)
      return
    }
    b.bZ = 0
    b.bVz = -b.bVz * 0.5
    // Çim sekmesi yatay hızı ciddi emer; ağırlıklı pas (falsolu/ölçülü)
    // alıcının önünde OTURUR, degaj ise zıplayarak yol alır
    const absorb = b.flight === 'pass' ? 0.35 : b.flight === 'cross' ? 0.45 : 0.5
    b.bVel.x *= absorb
    b.bVel.y *= absorb
    b.bounces = (b.bounces ?? 0) + 1
    b.curlA = 0
    if (b.bVz < 2.6) {
      // Yuvarlanmaya devir: hız sürekli ama çim yuvarlanma hızını sınırlar
      const cap = b.flight === 'pass' ? 4.5 : b.flight === 'cross' ? 6 : 7
      let vx = b.bVel.x
      let vy = b.bVel.y
      const sp = Math.hypot(vx, vy)
      if (sp > cap) {
        vx *= cap / sp
        vy *= cap / sp
      }
      sim.ball = { kind: 'rolling', pos: { ...pos }, vel: { x: vx, y: vy }, controllerId: -1 }
      return
    }
  }

  // Topun anlık yüksekliği (balistik): havadaki topa ayak uzanmaz
  const height = b.bZ

  // Uçuş ortası araya girme (paslar/ortalar) — yolun ilk çeyreği hariç ve
  // yalnız top erişilebilir yükseklikteyken. Ofsayt pasına savunma dokunmaz.
  if (!b.offside && b.t > 0.25 && b.t < 0.95 && height < 2) {
    const passingTeam = sim.players[b.byId].teamIdx
    for (const o of sim.active(1 - passingTeam)) {
      if (dist(o.pos, pos) < 0.8 && sim.rng.chance(0.08 * interceptSkill(o.info.attributes))) {
        sim.receiveBall(o.id, 0.45) // uçan topu kesmek zor kontrol edilir
        return
      }
    }
  }
  // Kaleci ortayı havada toplayabilir
  if (!b.offside && b.flight === 'cross' && b.t > 0.5 && height < 3) {
    const gk = sim.keeperOf(1 - sim.players[b.byId].teamIdx)
    if (gk && dist(gk.pos, pos) < 2.2 && sim.rng.chance(0.4)) {
      sim.possess(gk.id)
      return
    }
  }

  // KAFA VURUŞU: kafa hizasına inen havadan top (orta, degaj, uzun/lofted
  // pas) yakınındaki oyuncularca kafayla oynanır. Kazanan bölgeye göre
  // kaleye kafayı vurur, degaj eder ya da öne aşırtır (yukarıda resolveHeader).
  const canHead =
    b.flight === 'cross' || b.flight === 'clearance' || (b.flight === 'pass' && (b.hMax ?? 0) >= 3)
  if (!b.offside && canHead && b.t > 0.45 && height >= 1.7 && height <= 3.3) {
    let p1: PlayerSim | null = null
    let d1 = 1.7
    for (const p of sim.active()) {
      if (p.info.role === 'GK') continue
      const dd = dist(p.pos, pos)
      if (dd < d1) {
        d1 = dd
        p1 = p
      }
    }
    if (p1) {
      // En yakın rakip: <1.9 m ikili hava mücadelesi (p2), <4.5 m ise baskı
      // (kafayla ilk dokunuş meşru). Daha uzaksa rakipsiz sayılır.
      let p2: PlayerSim | null = null
      let d2 = 1.9
      let nearestOpp = 99
      for (const o of sim.active(1 - p1.teamIdx)) {
        if (o.info.role === 'GK') continue
        const dd = dist(o.pos, pos)
        if (dd < nearestOpp) nearestOpp = dd
        if (dd < d2) {
          d2 = dd
          p2 = o
        }
      }
      // Rakipsiz (baskısız) + savunma bölgesi dışındaki topu kafalama YOK:
      // oyuncu YERDEN kontrol etsin (top inmeye devam eder, first-touch
      // devralır) — gereksiz zincirleme kafa mücadelesi (ping-pong) azalır.
      const p1Att = sim.toAttack(p1.pos, p1.teamIdx)
      const defending = p1Att.x < -HALF_LENGTH + 24
      if (nearestOpp < 4.5 || defending) {
        let winner = p1
        if (p2) {
          // Kendi kalesini savunan (kale tarafındaki) oyuncuya hafif üstünlük
          const bonus = (p: PlayerSim): number =>
            sim.toAttack(p.pos, p.teamIdx).x < -HALF_LENGTH + 24 ? 0.15 : 0
          // Yorgun oyuncu az zıplar (keskinlik hava mücadelesini de etkiler)
          const s1 = aerialSkill(p1.info.attributes) * sharpness(p1.energy) + bonus(p1) + sim.rng.range(0, 0.5)
          const s2 = aerialSkill(p2.info.attributes) * sharpness(p2.energy) + bonus(p2) + sim.rng.range(0, 0.5)
          winner = s1 >= s2 ? p1 : p2
        }
        resolveHeader(sim, winner, pos)
        return
      }
    }
  }
}
