import {
  F_BALL_X,
  F_BALL_Y,
  F_CLOCK,
  F_LABEL,
  F_PLAYERS,
  F_POSS_AWAY,
  F_POSS_HOME,
  F_POSS_TEAM,
  F_REF_X,
  F_REF_Y,
  FRAME_STRIDE,
  HALF_GOAL,
  HALF_LENGTH,
  HALF_SECONDS,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
  PENALTY_SPOT_DIST,
  TICK_DT,
  TICKS_PER_SEC,
} from './constants'
import {
  drainPerMeter,
  energyFactor,
  interceptSkill,
  maxSpeed,
  passErrorRate,
  passSpeed,
  shootSkill,
} from './attributes'
import { FORMATIONS } from './formations'
import { createRng, type Rng } from './rng'
import { targetPosition } from './positioning'
import { stepToward } from './movement'
import { decide, shotQualityAt, type Decision } from './decisions'
import { attemptTackle } from './duels'
import { resolveShot, type ShotOutcome } from './shooting'
import { moveReferee } from './referee'
import { add, dist, lerp, norm, scale, sub, vec } from './vec'
import { buildHighlights } from './highlights'
import type {
  BallState,
  FormationSlot,
  MatchEvent,
  MatchEventKind,
  MatchResult,
  MatchStats,
  Phase,
  PlayerSim,
  RestartKind,
  TeamInfo,
  Vec2,
} from './types'

const MAX_TICKS = 2 * (HALF_SECONDS + 8 * 60) * TICKS_PER_SEC

class MatchSim {
  rng: Rng
  teams: [TeamInfo, TeamInfo]
  players: PlayerSim[] = []
  attackDir: [1 | -1, 1 | -1] = [1, -1]
  ball: BallState = { kind: 'loose', pos: vec(0, 0), vel: vec(0, 0) }
  phase: Phase = { kind: 'open' }
  restartTargets: (Vec2 | null)[] = []
  half: 1 | 2 = 1
  halfClock = 0
  stoppage = 0
  tick = 0
  finished = false
  score: [number, number] = [0, 0]
  possTicks: [number, number] = [0, 0]
  lastTouchTeam = 0
  lastTouchId = 0
  nextDecisionTick = 0
  refPos: Vec2 = vec(-10, -HALF_WIDTH + 6)
  pendingShot: ShotOutcome | null = null
  events: MatchEvent[] = []
  frames = new Float32Array(MAX_TICKS * FRAME_STRIDE)
  shots: [number, number] = [0, 0]
  shotsOnTarget: [number, number] = [0, 0]
  corners: [number, number] = [0, 0]
  fouls: [number, number] = [0, 0]
  yellowCards: [number, number] = [0, 0]
  redCards: [number, number] = [0, 0]
  passesAttempted: [number, number] = [0, 0]
  passesCompleted: [number, number] = [0, 0]

  constructor(home: TeamInfo, away: TeamInfo, seed: number) {
    this.rng = createRng(seed)
    this.teams = [home, away]
    for (let t = 0; t < 2; t++) {
      const info = this.teams[t]
      info.starters.forEach((p, i) => {
        this.players.push({
          id: t * 11 + i,
          info: p,
          teamIdx: t,
          slotIdx: i,
          pos: vec(0, 0),
          energy: 1,
          tackleCooldown: 0,
          sentOff: false,
          yellows: 0,
          dribbleDir: null,
        })
      })
    }
    this.stoppage = 45 + this.rng.int(0, 75)
    this.setupRestart('kickoff', 0, vec(0, 0), 25)
    this.snapToRestartTargets()
  }

  // --- yardımcılar ---

  slotOf(p: PlayerSim): FormationSlot {
    return FORMATIONS[this.teams[p.teamIdx].formation][p.slotIdx]
  }

  active(teamIdx?: number): PlayerSim[] {
    return this.players.filter(
      (p) => !p.sentOff && (teamIdx === undefined || p.teamIdx === teamIdx),
    )
  }

  keeperOf(teamIdx: number): PlayerSim | null {
    const gk = this.players[teamIdx * 11]
    return gk.sentOff ? null : gk
  }

  ballPos(): Vec2 {
    if (this.phase.kind === 'restart') return this.phase.spot
    const b = this.ball
    if (b.kind === 'loose') return b.pos
    if (b.kind === 'possessed') return this.players[b.playerId].pos
    return lerp(b.from, b.to, Math.min(1, b.t))
  }

  possTeam(): number {
    if (this.phase.kind === 'restart') return this.phase.forTeam
    const b = this.ball
    if (b.kind === 'possessed') return this.players[b.playerId].teamIdx
    if (b.kind === 'inFlight') return this.players[b.byId].teamIdx
    return this.lastTouchTeam
  }

  clockDisplay(): number {
    return this.half === 1 ? this.halfClock : HALF_SECONDS + this.halfClock
  }

  toAttack(p: Vec2, teamIdx: number): Vec2 {
    const d = this.attackDir[teamIdx]
    return { x: p.x * d, y: p.y * d }
  }

  fromAttack(p: Vec2, teamIdx: number): Vec2 {
    const d = this.attackDir[teamIdx]
    return { x: p.x * d, y: p.y * d }
  }

  pushEvent(kind: MatchEventKind, teamIdx: number, playerId = -1, targetId = -1): void {
    this.events.push({
      tick: this.tick,
      clock: this.clockDisplay(),
      kind,
      teamIdx,
      playerId,
      targetId,
      scoreHome: this.score[0],
      scoreAway: this.score[1],
    })
  }

  possess(playerId: number): void {
    this.ball = { kind: 'possessed', playerId }
    const p = this.players[playerId]
    this.lastTouchTeam = p.teamIdx
    this.lastTouchId = playerId
    p.dribbleDir = null
    // Kontrol dokunuşu: top alındıktan sonra karar için kısa süre geçer;
    // bu süre savunmanın baskı kurmasına imkân verir
    this.nextDecisionTick = this.tick + (p.info.role === 'GK' ? 12 : 9)
  }

  looseBall(pos: Vec2, velDir: Vec2, speed: number): void {
    this.ball = { kind: 'loose', pos: { ...pos }, vel: scale(norm(velDir), speed) }
  }

  // --- restart kurulumu ---

  setupRestart(kind: RestartKind, forTeam: number, spot: Vec2, timer: number): void {
    const takerId = this.pickTaker(kind, forTeam, spot)
    this.phase = { kind: 'restart', restart: kind, forTeam, spot: { ...spot }, timer, takerId }
    this.lastTouchTeam = forTeam
    this.lastTouchId = takerId
    this.computeRestartTargets()
  }

  pickTaker(kind: RestartKind, forTeam: number, spot: Vec2): number {
    const mates = this.active(forTeam)
    if (kind === 'goal_kick') return this.keeperOf(forTeam)?.id ?? mates[0].id
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
        if (this.slotOf(m).role !== 'FW') continue
        if (!best || dist(m.pos, spot) < dist(best.pos, spot)) best = m
      }
      return (best ?? mates[mates.length - 1]).id
    }
    // taç / korner / serbest vuruş: en yakın saha oyuncusu
    let best: PlayerSim | null = null
    for (const m of mates) {
      if (m.info.role === 'GK') continue
      if (!best || dist(m.pos, spot) < dist(best.pos, spot)) best = m
    }
    return (best ?? mates[0]).id
  }

  computeRestartTargets(): void {
    if (this.phase.kind !== 'restart') return
    const { restart, forTeam, spot, takerId } = this.phase
    const targets: (Vec2 | null)[] = new Array(22).fill(null)
    targets[takerId] = { ...spot }

    if (restart === 'kickoff') {
      for (const p of this.players) {
        if (p.sentOff) continue
        const d = this.attackDir[p.teamIdx]
        const slot = this.slotOf(p)
        const home = {
          x: Math.min((slot.depth - 0.5) * HALF_LENGTH * 2, -2.5),
          y: slot.width * HALF_WIDTH * 0.85,
        }
        targets[p.id] = { x: home.x * d, y: home.y * d }
      }
      targets[takerId] = { ...spot }
      // santrada destek oyuncusu
      const support = this.active(forTeam)
        .filter((p) => p.id !== takerId && this.slotOf(p).role === 'FW')
        .sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))[0]
      if (support) targets[support.id] = { x: -1.5 * this.attackDir[forTeam], y: 1.5 }
    } else if (restart === 'corner') {
      const defTeam = 1 - forTeam
      const goalX = HALF_LENGTH * this.attackDir[forTeam]
      const boxCenter = { x: goalX - 8 * this.attackDir[forTeam], y: 0 }
      const attackers = this.active(forTeam)
        .filter((p) => p.id !== takerId && this.slotOf(p).depth >= 0.4)
        .sort((a, b) => this.slotOf(b).depth - this.slotOf(a).depth)
        .slice(0, 5)
      attackers.forEach((p, i) => {
        targets[p.id] = {
          x: boxCenter.x + this.rng.range(-4, 4),
          y: boxCenter.y + (i - 2) * 4 + this.rng.range(-1.5, 1.5),
        }
      })
      const defenders = this.active(defTeam)
        .filter((p) => p.info.role !== 'GK' && this.slotOf(p).depth <= 0.45)
        .slice(0, 6)
      defenders.forEach((p, i) => {
        // kale tarafında (gol çizgisine attackerlardan daha yakın) markaj
        targets[p.id] = {
          x: boxCenter.x + this.attackDir[forTeam] * 1.5 + this.rng.range(-3, 3),
          y: (i - 2.5) * 3.6,
        }
      })
      const gk = this.keeperOf(defTeam)
      if (gk) targets[gk.id] = { x: goalX - this.attackDir[forTeam] * 1, y: 0 }
    } else if (restart === 'penalty') {
      const defTeam = 1 - forTeam
      const gk = this.keeperOf(defTeam)
      const goalX = HALF_LENGTH * this.attackDir[forTeam]
      if (gk) targets[gk.id] = { x: goalX - this.attackDir[forTeam] * 0.8, y: 0 }
      targets[takerId] = {
        x: spot.x - 2 * this.attackDir[forTeam],
        y: spot.y,
      }
      // diğerleri ceza sahası dışına
      const boxEdgeX = HALF_LENGTH - PENALTY_AREA_DEPTH
      for (const p of this.players) {
        if (p.sentOff || p.id === takerId || (gk && p.id === gk.id)) continue
        const att = this.toAttack(p.pos, forTeam)
        if (att.x > boxEdgeX - 1 && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2 + 1) {
          targets[p.id] = this.fromAttack(
            { x: boxEdgeX - 2.5, y: Math.max(-18, Math.min(18, att.y)) },
            forTeam,
          )
        }
      }
    }
    this.restartTargets = targets
  }

  snapToRestartTargets(): void {
    for (const p of this.players) {
      if (p.sentOff) continue
      const t = this.restartTargets[p.id]
      if (t) p.pos = { ...t }
      else {
        const slot = this.slotOf(p)
        p.pos = targetPosition(slot, this.attackDir[p.teamIdx], vec(0, 0), p.teamIdx === 0)
      }
    }
  }

  // --- uçuş başlatma ---

  launchPass(byId: number, targetId: number, flight: 'pass' | 'cross' = 'pass'): void {
    const by = this.players[byId]
    const to = this.players[targetId]
    const from = { ...this.ballPos() }
    const lead = scale(norm(sub(to.pos, from)), 1.2)
    const err = passErrorRate(by.info.attributes)
    const d0 = dist(from, to.pos)
    const target = {
      x: to.pos.x + lead.x + this.rng.range(-1, 1) * err * d0,
      y: to.pos.y + lead.y + this.rng.range(-1, 1) * err * d0,
    }
    const d = Math.max(1, dist(from, target))
    this.ball = {
      kind: 'inFlight',
      from,
      to: target,
      t: 0,
      duration: d / passSpeed(by.info.attributes),
      flight,
      byId,
      targetId,
    }
    this.lastTouchTeam = by.teamIdx
    this.lastTouchId = byId
    this.passesAttempted[by.teamIdx]++
    this.pushEvent('pass', by.teamIdx, byId, targetId)
  }

  launchShot(byId: number, quality: number): void {
    const by = this.players[byId]
    const from = { ...this.ballPos() }
    const dir = this.attackDir[by.teamIdx]
    const keeper = this.keeperOf(1 - by.teamIdx)

    // Şut anında blok kontrolü
    const goal = { x: HALF_LENGTH * dir, y: 0 }
    for (const o of this.active(1 - by.teamIdx)) {
      if (o.info.role === 'GK') continue
      const toGoal = dist(from, goal)
      const oDist = dist(o.pos, from)
      if (oDist < 3 && dist(o.pos, goal) < toGoal && this.rng.chance(0.22)) {
        this.shots[by.teamIdx]++
        this.pushEvent('shot_blocked', by.teamIdx, byId)
        this.looseBall(o.pos, sub(o.pos, from), this.rng.range(2, 5))
        this.lastTouchTeam = o.teamIdx
        this.lastTouchId = o.id
        return
      }
    }

    const outcome = resolveShot(quality, keeper, this.rng)
    this.pendingShot = outcome
    let targetY: number
    if (outcome.kind === 'missed') {
      targetY = (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(HALF_GOAL + 0.4, HALF_GOAL + 4)
    } else {
      targetY = this.rng.range(-HALF_GOAL + 0.5, HALF_GOAL - 0.5)
    }
    const target = { x: HALF_LENGTH * dir, y: targetY }
    const d = Math.max(1, dist(from, target))
    this.ball = {
      kind: 'inFlight',
      from,
      to: target,
      t: 0,
      duration: d / 22,
      flight: 'shot',
      byId,
      targetId: null,
      shotQuality: quality,
    }
    this.lastTouchTeam = by.teamIdx
    this.lastTouchId = byId
    this.shots[by.teamIdx]++
  }

  launchClearance(byId: number): void {
    const by = this.players[byId]
    const from = { ...this.ballPos() }
    const dir = this.attackDir[by.teamIdx]
    const target = {
      x: Math.min(HALF_LENGTH - 3, Math.max(-HALF_LENGTH + 3, from.x + dir * this.rng.range(22, 38))),
      y: Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, from.y + this.rng.range(-14, 14))),
    }
    const d = Math.max(1, dist(from, target))
    this.ball = {
      kind: 'inFlight',
      from,
      to: target,
      t: 0,
      duration: d / 19,
      flight: 'clearance',
      byId,
      targetId: null,
    }
    this.lastTouchTeam = by.teamIdx
    this.lastTouchId = byId
  }

  // --- restart yürütme ---

  executeRestart(): void {
    if (this.phase.kind !== 'restart') return
    const { restart, forTeam, spot, takerId } = this.phase
    this.phase = { kind: 'open' }
    this.restartTargets = []
    const taker = this.players[takerId]
    taker.pos = { ...spot }

    if (restart === 'kickoff') {
      const mates = this.active(forTeam).filter((p) => p.id !== takerId)
      mates.sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))
      this.pushEvent('kickoff', forTeam, takerId)
      if (mates[0]) this.launchPass(takerId, mates[0].id)
      else this.possess(takerId)
      return
    }

    if (restart === 'corner') {
      const dir = this.attackDir[forTeam]
      const landing = {
        x: HALF_LENGTH * dir - dir * this.rng.range(4, 11),
        y: this.rng.range(-7, 7),
      }
      const attackers = this.active(forTeam).filter(
        (p) => p.id !== takerId && p.info.role !== 'GK',
      )
      attackers.sort((a, b) => dist(a.pos, landing) - dist(b.pos, landing))
      const targetId = attackers[0]?.id ?? null
      const d = Math.max(1, dist(spot, landing))
      this.ball = {
        kind: 'inFlight',
        from: { ...spot },
        to: landing,
        t: 0,
        duration: d / 16,
        flight: 'cross',
        byId: takerId,
        targetId,
      }
      this.passesAttempted[forTeam]++
      return
    }

    if (restart === 'penalty') {
      const quality = 0.68 + shootSkill(taker.info.attributes) * 0.25
      this.launchShot(takerId, Math.min(0.95, quality))
      return
    }

    if (restart === 'free_kick') {
      const att = this.toAttack(spot, forTeam)
      const goalDist = dist(att, { x: HALF_LENGTH, y: 0 })
      if (goalDist < 26 && Math.abs(att.y) < 18) {
        const q = shotQualityAt(taker, att, this.active(1 - forTeam)) * 0.75
        if (q > 0.03) {
          this.launchShot(takerId, q)
          return
        }
      }
    }

    // taç / kale vuruşu / pas restartı: en uygun yakın takım arkadaşına pas
    this.possess(takerId)
    const mates = this.active(forTeam).filter((p) => p.id !== takerId)
    let best: PlayerSim | null = null
    let bestScore = -Infinity
    for (const m of mates) {
      const dm = dist(m.pos, spot)
      if (dm > (restart === 'goal_kick' ? 55 : 30)) continue
      let recvMin = 99
      for (const o of this.active(1 - forTeam)) recvMin = Math.min(recvMin, dist(o.pos, m.pos))
      const score = Math.min(1, recvMin / 8) - dm / 60
      if (score > bestScore) {
        bestScore = score
        best = m
      }
    }
    if (best) this.launchPass(takerId, best.id)
    else this.launchClearance(takerId)
  }

  // --- olay çözümleri ---

  addStoppage(sec: number): void {
    this.stoppage = Math.min(300, this.stoppage + sec)
  }

  scoreGoal(byId: number): void {
    const by = this.players[byId]
    this.score[by.teamIdx]++
    this.shotsOnTarget[by.teamIdx]++
    this.pushEvent('goal', by.teamIdx, byId)
    this.addStoppage(20)
    const conceding = 1 - by.teamIdx
    this.setupRestart('kickoff', conceding, vec(0, 0), 45)
  }

  handleFoul(tacklerId: number, victimId: number): void {
    const tackler = this.players[tacklerId]
    const victim = this.players[victimId]
    const spot = { ...victim.pos }
    this.fouls[tackler.teamIdx]++
    this.addStoppage(8)
    this.pushEvent('foul', tackler.teamIdx, tacklerId, victimId)

    // Kart zarları
    if (this.rng.chance(0.003)) {
      this.sendOff(tackler, true)
    } else if (this.rng.chance(0.08)) {
      tackler.yellows++
      this.yellowCards[tackler.teamIdx]++
      this.pushEvent('yellow_card', tackler.teamIdx, tacklerId)
      if (tackler.yellows >= 2) this.sendOff(tackler, false)
    }

    // Ceza sahasında mı? (müdahaleyi yapanın kendi ceza sahası)
    const att = this.toAttack(spot, victim.teamIdx)
    const inBox =
      att.x > HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
    if (inBox) {
      this.pushEvent('penalty_awarded', victim.teamIdx, victimId)
      const penSpot = this.fromAttack({ x: HALF_LENGTH - PENALTY_SPOT_DIST, y: 0 }, victim.teamIdx)
      this.setupRestart('penalty', victim.teamIdx, penSpot, 40)
    } else {
      this.pushEvent('free_kick', victim.teamIdx, victimId)
      this.setupRestart('free_kick', victim.teamIdx, spot, 25)
    }
  }

  sendOff(p: PlayerSim, straight: boolean): void {
    this.redCards[p.teamIdx]++
    this.pushEvent('red_card', p.teamIdx, p.id)
    p.sentOff = true
    // Soyunma odasına: canvas dünya kutusunun dışına park edilir, çizilmez
    p.pos = { x: 0, y: HALF_WIDTH + 25 + p.teamIdx * 3 }
    if (!straight) p.yellows = 2
  }

  outOfBounds(pos: Vec2): void {
    // Taç
    if (Math.abs(pos.y) > HALF_WIDTH) {
      const forTeam = 1 - this.lastTouchTeam
      const spot = {
        x: Math.max(-HALF_LENGTH + 1, Math.min(HALF_LENGTH - 1, pos.x)),
        y: Math.sign(pos.y) * (HALF_WIDTH - 0.3),
      }
      this.pushEvent('throw_in', forTeam)
      this.setupRestart('throw_in', forTeam, spot, 15)
      return
    }
    // Kale çizgisi
    const side = Math.sign(pos.x) // hangi kale çizgisi
    const defTeam = this.attackDir[0] === side ? 1 : 0 // o kaleyi savunan takım
    const attTeam = 1 - defTeam
    if (this.lastTouchTeam === defTeam) {
      // savunan takım çıkardı → korner
      this.corners[attTeam]++
      this.pushEvent('corner', attTeam)
      const spot = { x: side * (HALF_LENGTH - 0.5), y: Math.sign(pos.y || 1) * (HALF_WIDTH - 0.5) }
      this.setupRestart('corner', attTeam, spot, 30)
    } else {
      this.pushEvent('goal_kick', defTeam)
      const spot = this.fromAttack({ x: -HALF_LENGTH + 5.5, y: 0 }, defTeam)
      this.setupRestart('goal_kick', defTeam, spot, 20)
    }
  }

  resolveShotArrival(): void {
    if (this.ball.kind !== 'inFlight') return
    const { byId } = this.ball
    const by = this.players[byId]
    const outcome = this.pendingShot ?? { kind: 'missed' as const }
    this.pendingShot = null
    const keeper = this.keeperOf(1 - by.teamIdx)

    if (outcome.kind === 'goal') {
      this.scoreGoal(byId)
      return
    }
    if (outcome.kind === 'missed') {
      this.pushEvent('shot_missed', by.teamIdx, byId)
      const defTeam = 1 - by.teamIdx
      // Bazen savunmadan sekip kornere çıkar
      if (this.rng.chance(0.22)) {
        this.corners[by.teamIdx]++
        this.pushEvent('corner', by.teamIdx)
        const dir = this.attackDir[by.teamIdx]
        const spot = {
          x: dir * (HALF_LENGTH - 0.5),
          y: Math.sign(this.ball.to.y || 1) * (HALF_WIDTH - 0.5),
        }
        this.setupRestart('corner', by.teamIdx, spot, 30)
        return
      }
      const spot = this.fromAttack({ x: -HALF_LENGTH + 5.5, y: 0 }, defTeam)
      this.pushEvent('goal_kick', defTeam)
      this.setupRestart('goal_kick', defTeam, spot, 20)
      return
    }
    this.shotsOnTarget[by.teamIdx]++
    if (outcome.kind === 'parried_corner') {
      this.pushEvent('shot_saved', by.teamIdx, byId, keeper?.id ?? -1)
      this.corners[by.teamIdx]++
      this.pushEvent('corner', by.teamIdx)
      const dir = this.attackDir[by.teamIdx]
      const ballY = this.ball.to.y
      const spot = { x: dir * (HALF_LENGTH - 0.5), y: Math.sign(ballY || 1) * (HALF_WIDTH - 0.5) }
      this.setupRestart('corner', by.teamIdx, spot, 30)
      return
    }
    // saved
    this.pushEvent('shot_saved', by.teamIdx, byId, keeper?.id ?? -1)
    if (keeper && outcome.kind === 'saved' && outcome.held) {
      keeper.pos = { ...this.ball.to }
      this.possess(keeper.id)
    } else if (keeper) {
      // öne çeldi → ceza sahasında tehlikeli boş top
      const dir = this.attackDir[by.teamIdx]
      const dropPos = {
        x: this.ball.to.x - dir * this.rng.range(5, 10),
        y: this.ball.to.y + this.rng.range(-6, 6),
      }
      this.looseBall(dropPos, { x: -dir, y: this.rng.range(-0.5, 0.5) }, this.rng.range(1, 3))
      this.lastTouchTeam = keeper.teamIdx
      this.lastTouchId = keeper.id
    } else {
      this.looseBall(this.ball.to, { x: -this.attackDir[by.teamIdx], y: 0 }, 2)
    }
  }

  resolvePassArrival(): void {
    if (this.ball.kind !== 'inFlight') return
    const { to, targetId, byId } = this.ball
    const by = this.players[byId]

    // Varış noktasına en yakın hücumcu (tercihen hedef oyuncu) ve savunmacı
    let att: PlayerSim | null = null
    let attD = 99
    let def: PlayerSim | null = null
    let defD = 99
    for (const p of this.active()) {
      const d = dist(p.pos, to)
      if (p.teamIdx === by.teamIdx) {
        if (d < attD) {
          attD = d
          att = p
        }
      } else if (d < defD) {
        defD = d
        def = p
      }
    }
    if (targetId !== null && !this.players[targetId].sentOff) {
      const recv = this.players[targetId]
      const d = dist(recv.pos, to)
      if (d < attD + 0.8) {
        att = recv
        attD = d
      }
    }

    const attClose = att !== null && attD < 2.4
    const defClose = def !== null && defD < 2.4

    if (attClose && defClose && att && def) {
      // Çekişmeli varış: yakınlık + pozisyon alma becerisi
      const wa = (2.4 - attD) * interceptSkill(att.info.attributes) * 1.1
      const wd = (2.4 - defD) * interceptSkill(def.info.attributes)
      if (this.rng.next() < wa / (wa + wd)) {
        att.pos = { ...to }
        this.possess(att.id)
        this.passesCompleted[by.teamIdx]++
      } else {
        this.possess(def.id)
        this.pushEvent('interception', def.teamIdx, def.id)
      }
      return
    }
    if (attClose && att) {
      att.pos = { ...to }
      this.possess(att.id)
      this.passesCompleted[by.teamIdx]++
      return
    }
    if (defClose && def) {
      this.possess(def.id)
      this.pushEvent('interception', def.teamIdx, def.id)
      return
    }
    const flightDir = norm(sub(to, this.ball.from))
    this.looseBall(to, flightDir, 2.5)
  }

  // --- tick ---

  step(): void {
    if (this.finished) return
    const dt = TICK_DT

    // Yarı sonu kontrolü (güvenli anda)
    if (
      this.halfClock >= HALF_SECONDS + this.stoppage &&
      this.phase.kind === 'open' &&
      this.ball.kind !== 'inFlight'
    ) {
      if (this.half === 1) {
        this.pushEvent('half_end', -1)
        this.half = 2
        this.halfClock = 0
        this.stoppage = 45 + this.rng.int(0, 105)
        this.attackDir = [-1, 1]
        this.setupRestart('kickoff', 1, vec(0, 0), 30)
        this.snapToRestartTargets()
      } else {
        this.pushEvent('full_time', -1)
        this.finished = true
        this.recordFrame()
        return
      }
    }

    if (this.phase.kind === 'restart') {
      this.stepRestart(dt)
    } else {
      this.stepOpen(dt)
    }

    this.refPos = moveReferee(this.refPos, this.ballPos(), dt)
    for (const p of this.players) {
      if (p.tackleCooldown > 0) p.tackleCooldown = Math.max(0, p.tackleCooldown - dt)
    }

    const poss = this.possTeam()
    if (poss === 0) this.possTicks[0]++
    else if (poss === 1) this.possTicks[1]++

    this.recordFrame()
    this.halfClock += dt
    this.tick++
  }

  stepRestart(dt: number): void {
    if (this.phase.kind !== 'restart') return
    for (const p of this.active()) {
      const t = this.restartTargets[p.id]
      const target =
        t ??
        targetPosition(
          this.slotOf(p),
          this.attackDir[p.teamIdx],
          this.phase.spot,
          p.teamIdx === this.phase.forTeam,
        )
      const spd = maxSpeed(p.info.attributes) * energyFactor(p.energy) * 0.85
      p.pos = stepToward(p.pos, target, spd, dt)
    }
    this.phase.timer--
    if (this.phase.timer <= 0) this.executeRestart()
  }

  stepOpen(dt: number): void {
    // 1) Top durumu
    if (this.ball.kind === 'possessed') {
      this.stepPossessed()
    } else if (this.ball.kind === 'inFlight') {
      this.stepInFlight(dt)
    } else {
      this.stepLoose(dt)
    }

    // 2) Oyuncu hareketi (top yeni duruma geçmiş olabilir)
    if (this.phase.kind === 'open') this.movePlayers(dt)
  }

  stepPossessed(): void {
    if (this.ball.kind !== 'possessed') return
    const carrier = this.players[this.ball.playerId]
    const opponents = this.active(1 - carrier.teamIdx)

    // Müdahale denemeleri
    const outcome = attemptTackle(carrier, opponents, this.rng)
    if (outcome.kind === 'foul') {
      this.players[outcome.tacklerId].tackleCooldown = 3
      this.handleFoul(outcome.tacklerId, carrier.id)
      return
    }
    if (outcome.kind === 'won') {
      const tackler = this.players[outcome.tacklerId]
      tackler.tackleCooldown = 1.5
      this.pushEvent('tackle', tackler.teamIdx, tackler.id, carrier.id)
      if (outcome.toFeet) {
        this.possess(tackler.id)
      } else {
        this.looseBall(
          carrier.pos,
          { x: this.rng.range(-1, 1), y: this.rng.range(-1, 1) },
          this.rng.range(2, 5),
        )
        this.lastTouchTeam = tackler.teamIdx
        this.lastTouchId = tackler.id
      }
      return
    }
    if (outcome.kind === 'beaten') {
      this.players[outcome.tacklerId].tackleCooldown = 0.8
    }

    // Karar zamanı mı?
    if (this.tick >= this.nextDecisionTick) {
      const mates = this.active(carrier.teamIdx)
      if (carrier.info.role === 'GK') {
        this.gkDistribute(carrier, mates, opponents)
        return
      }
      const decision: Decision = decide(
        carrier,
        mates,
        opponents,
        this.attackDir[carrier.teamIdx],
        this.rng,
      )
      this.nextDecisionTick = this.tick + 8
      if (decision.kind === 'pass') {
        this.launchPass(carrier.id, decision.targetId)
        return
      }
      if (decision.kind === 'shoot') {
        this.launchShot(carrier.id, decision.quality)
        return
      }
      if (decision.kind === 'clear') {
        this.launchClearance(carrier.id)
        return
      }
      // dribble: yön belirle, hafif gürültü
      const noisy = norm({
        x: decision.dir.x + this.rng.range(-0.25, 0.25),
        y: decision.dir.y + this.rng.range(-0.35, 0.35),
      })
      carrier.dribbleDir = noisy
    }
  }

  gkDistribute(gk: PlayerSim, mates: PlayerSim[], opponents: PlayerSim[]): void {
    this.nextDecisionTick = this.tick + 5
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
    if (best && bestScore > 0.25) this.launchPass(gk.id, best.id)
    else this.launchClearance(gk.id)
  }

  stepInFlight(dt: number): void {
    if (this.ball.kind !== 'inFlight') return
    const b = this.ball
    b.t += dt / b.duration
    const pos = lerp(b.from, b.to, Math.min(1, b.t))

    if (b.flight === 'shot') {
      if (b.t >= 1 || Math.abs(pos.x) >= HALF_LENGTH - 0.1) {
        this.resolveShotArrival()
      }
      return
    }

    // Uçuş ortası araya girme (paslar/ortalar) — yolun ilk çeyreği hariç
    if (b.t > 0.25 && b.t < 0.95) {
      const passingTeam = this.players[b.byId].teamIdx
      for (const o of this.active(1 - passingTeam)) {
        if (dist(o.pos, pos) < 0.9 && this.rng.chance(0.09 * interceptSkill(o.info.attributes))) {
          o.pos = { ...pos }
          this.possess(o.id)
          this.pushEvent('interception', o.teamIdx, o.id)
          return
        }
      }
      // Kaleci ortayı toplayabilir
      if (b.flight === 'cross') {
        const gk = this.keeperOf(1 - passingTeam)
        if (gk && dist(gk.pos, pos) < 2.2 && this.rng.chance(0.4)) {
          gk.pos = { ...pos }
          this.possess(gk.id)
          this.pushEvent('interception', gk.teamIdx, gk.id)
          return
        }
      }
    }

    // Saha dışına mı gidiyor?
    if (Math.abs(pos.y) > HALF_WIDTH || Math.abs(pos.x) > HALF_LENGTH) {
      this.outOfBounds(pos)
      return
    }

    if (b.t >= 1) this.resolvePassArrival()
  }

  stepLoose(dt: number): void {
    if (this.ball.kind !== 'loose') return
    const b = this.ball
    b.pos = add(b.pos, scale(b.vel, dt))
    b.vel = scale(b.vel, Math.max(0, 1 - 1.7 * dt))

    if (Math.abs(b.pos.y) > HALF_WIDTH || Math.abs(b.pos.x) > HALF_LENGTH) {
      this.outOfBounds(b.pos)
      return
    }

    // Kapma: 0.9 m içindeki oyuncular arasında pozisyon alma ağırlıklı kura
    const contenders = this.active().filter((p) => dist(p.pos, b.pos) < 0.9)
    if (contenders.length === 1) {
      this.possess(contenders[0].id)
    } else if (contenders.length > 1) {
      let total = 0
      const weights = contenders.map((p) => {
        const w = interceptSkill(p.info.attributes)
        total += w
        return w
      })
      let roll = this.rng.next() * total
      for (let i = 0; i < contenders.length; i++) {
        roll -= weights[i]
        if (roll <= 0) {
          this.possess(contenders[i].id)
          break
        }
      }
    }
  }

  chaserIds(): Set<number> {
    // Boş topa takım başına en yakın 2 oyuncu gider; uçuştaki topun varış
    // noktasına ise savunan takımdan en yakın 2 oyuncu koşar (pas alıcısı zaten
    // ayrıca koşuyor). Diğerleri pozisyonunu korur.
    const ids = new Set<number>()
    if (this.ball.kind === 'possessed') return ids

    if (this.ball.kind === 'inFlight') {
      if (this.ball.flight === 'shot') return ids
      const passingTeam = this.players[this.ball.byId].teamIdx
      const landing = this.ball.to
      const defenders = this.active(1 - passingTeam).filter((p) => p.info.role !== 'GK')
      defenders.sort((a, b) => dist(a.pos, landing) - dist(b.pos, landing))
      for (const c of defenders.slice(0, 2)) ids.add(c.id)
      return ids
    }

    const bp = this.ballPos()
    for (let t = 0; t < 2; t++) {
      const candidates = this.active(t).filter((p) => {
        if (p.info.role !== 'GK') return true
        // GK yalnızca kendi ceza sahasındaki topa çıkar
        const att = this.toAttack(bp, t)
        return att.x < -HALF_LENGTH + PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
      })
      candidates.sort((a, b) => dist(a.pos, bp) - dist(b.pos, bp))
      for (const c of candidates.slice(0, 2)) ids.add(c.id)
    }
    return ids
  }

  movePlayers(dt: number): void {
    const bp = this.ballPos()
    const possTeam = this.possTeam()
    const chasers = this.chaserIds()
    const carrierId = this.ball.kind === 'possessed' ? this.ball.playerId : -1

    // Topu taşıyana en yakın 1-2 savunmacı baskı yapar
    const presserIds = new Set<number>()
    if (carrierId >= 0) {
      const carrier = this.players[carrierId]
      const defs = this.active(1 - carrier.teamIdx)
        .filter((o) => o.info.role !== 'GK')
        .map((o) => ({ o, d: dist(o.pos, carrier.pos) }))
        .sort((a, b) => a.d - b.d)
      if (defs[0] && defs[0].d < 14) presserIds.add(defs[0].o.id)
      if (defs[1] && defs[1].d < 10) presserIds.add(defs[1].o.id)
    }

    // Pas hedefindeki oyuncu topun varış noktasına koşar
    const receiverId =
      this.ball.kind === 'inFlight' && this.ball.targetId !== null ? this.ball.targetId : -1
    const flightTo = this.ball.kind === 'inFlight' ? this.ball.to : null

    for (const p of this.active()) {
      let target: Vec2
      let sprint = false

      if (p.id === carrierId) {
        if (p.dribbleDir) {
          target = add(p.pos, scale(p.dribbleDir, 6))
          sprint = true
        } else {
          target = p.pos
        }
      } else if (p.id === receiverId && flightTo) {
        target = flightTo
        sprint = true
      } else if (chasers.has(p.id)) {
        if (this.ball.kind === 'loose') target = add(bp, scale(this.ball.vel, 0.3))
        else if (flightTo) target = flightTo
        else target = bp
        sprint = true
      } else if (presserIds.has(p.id)) {
        target = bp
        sprint = true
      } else {
        target = targetPosition(this.slotOf(p), this.attackDir[p.teamIdx], bp, possTeam === p.teamIdx)
      }

      const before = { ...p.pos }
      // Hedefinden çok uzak kalan oyuncu pozisyon almak için de tam koşar
      const far = !sprint && dist(p.pos, target) > 8
      const spd =
        maxSpeed(p.info.attributes) *
        energyFactor(p.energy) *
        (sprint || far ? 1 : 0.76) *
        (p.id === carrierId ? 0.78 : 1)
      p.pos = stepToward(p.pos, target, spd, dt)

      const moved = dist(before, p.pos)
      p.energy = Math.max(0.35, p.energy - moved * drainPerMeter(p.info.attributes))
      if (moved < 0.1 * dt * spd) p.energy = Math.min(1, p.energy + 0.002 * dt)
    }
  }

  recordFrame(): void {
    const o = this.tick * FRAME_STRIDE
    const f = this.frames
    const bp = this.ballPos()
    let label = -1
    if (this.ball.kind === 'possessed') label = this.ball.playerId
    else label = this.lastTouchId
    f[o + F_CLOCK] = this.clockDisplay()
    f[o + F_LABEL] = label
    f[o + F_POSS_TEAM] = this.possTeam()
    f[o + F_BALL_X] = bp.x
    f[o + F_BALL_Y] = bp.y
    f[o + F_REF_X] = this.refPos.x
    f[o + F_REF_Y] = this.refPos.y
    f[o + F_POSS_HOME] = this.possTicks[0]
    f[o + F_POSS_AWAY] = this.possTicks[1]
    for (let i = 0; i < 22; i++) {
      f[o + F_PLAYERS + i * 2] = this.players[i].pos.x
      f[o + F_PLAYERS + i * 2 + 1] = this.players[i].pos.y
    }
  }

  buildStats(): MatchStats {
    const totalPoss = Math.max(1, this.possTicks[0] + this.possTicks[1])
    return {
      possession: [
        Math.round((this.possTicks[0] / totalPoss) * 100),
        Math.round((this.possTicks[1] / totalPoss) * 100),
      ],
      shots: [...this.shots],
      shotsOnTarget: [...this.shotsOnTarget],
      goals: [...this.score],
      corners: [...this.corners],
      fouls: [...this.fouls],
      yellowCards: [...this.yellowCards],
      redCards: [...this.redCards],
      passes: [...this.passesAttempted],
      passesCompleted: [...this.passesCompleted],
    }
  }
}

export function simulateMatch(
  home: TeamInfo,
  away: TeamInfo,
  seed: number,
): MatchResult {
  const sim = new MatchSim(home, away, seed)
  while (!sim.finished && sim.tick < MAX_TICKS - 1) {
    sim.step()
  }
  const frameCount = sim.tick + 1
  return {
    frames: sim.frames.subarray(0, frameCount * FRAME_STRIDE),
    frameCount,
    events: sim.events,
    stats: sim.buildStats(),
    highlights: buildHighlights(sim.events, frameCount),
    seed,
    teams: [home, away],
  }
}
