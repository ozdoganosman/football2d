import {
  F_BALL_H,
  F_BALL_X,
  F_BALL_Y,
  F_CLOCK,
  F_DOWN,
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
  controlSkill,
  drainPerMeter,
  dribbleSkill,
  energyFactor,
  interceptSkill,
  maxSpeed,
  passErrorRate,
  passSpeed,
  shootSkill,
  tackleSkill,
} from './attributes'
import { FORMATIONS } from './formations'
import { createRng, type Rng } from './rng'
import { targetPosition } from './positioning'
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
  ball: BallState = { kind: 'rolling', pos: vec(0, 0), vel: vec(0, 0), controllerId: -1 }
  phase: Phase = { kind: 'open' }
  restartTargets: (Vec2 | null)[] = []
  engagerId: [number, number] = [-1, -1] // takım başına topa giden görevli (histerezis)
  lastTurnover = { tick: -999, team: -1 } // kontra penceresi takibi
  downedId = -1 // faulle yerde kalan oyuncu
  downedUntil = -1
  freezeUntil = -1 // düdük sonrası herkesin durduğu an
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
  offsides: [number, number] = [0, 0]
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
          vel: vec(0, 0),
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
    if (b.kind === 'rolling') return b.pos
    return this.flightPos(b)
  }

  // Uçuş konumu: yerden paslar sürtünmeyle yavaşlayarak varır (ease-out),
  // havadan toplar ve şutlar sabit tempoda gider
  flightPos(b: Extract<BallState, { kind: 'inFlight' }>): Vec2 {
    const tt = Math.min(1, b.t)
    const eased =
      b.flight === 'shot' || (b.hMax ?? 0) > 0 ? tt : 1 - Math.pow(1 - tt, 1.6)
    return lerp(b.from, b.to, eased)
  }

  possTeam(): number {
    if (this.phase.kind === 'restart') return this.phase.forTeam
    const b = this.ball
    if (b.kind === 'rolling') {
      return b.controllerId >= 0 ? this.players[b.controllerId].teamIdx : this.lastTouchTeam
    }
    return this.players[b.byId].teamIdx
  }

  controllerId(): number {
    return this.ball.kind === 'rolling' ? this.ball.controllerId : -1
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

  // Topun kontrolünü al: top fiziksel kalır (yerinden oynamaz), yalnız
  // kontrolcü değişir. `at` verilirse top oraya yerleştirilir (restart vb.)
  possess(playerId: number, at?: Vec2): void {
    const pos = at ?? (this.ball.kind === 'rolling' ? this.ball.pos : this.ballPos())
    this.ball = { kind: 'rolling', pos: { ...pos }, vel: vec(0, 0), controllerId: playerId }
    const p = this.players[playerId]
    if (p.teamIdx !== this.lastTouchTeam) {
      this.lastTurnover = { tick: this.tick, team: p.teamIdx }
    }
    this.lastTouchTeam = p.teamIdx
    this.lastTouchId = playerId
    p.dribbleDir = null
    // İlk dokunuş momentumun bir kısmını öldürür (süzülme sınırlı kalır)
    p.vel = scale(p.vel, 0.45)
    // Kontrol dokunuşu: top alındıktan sonra karar için kısa süre geçer;
    // bu süre savunmanın baskı kurmasına imkân verir
    this.nextDecisionTick = this.tick + (p.info.role === 'GK' ? 12 : 9)
    // İlk dokunuş koruması: alıcı topu kontrol edecek kadar zaman bulur
    for (const o of this.active(1 - p.teamIdx)) {
      if (dist(o.pos, p.pos) < 2.5) {
        o.tackleCooldown = Math.max(o.tackleCooldown, 0.6)
      }
    }
  }

  looseBall(pos: Vec2, velDir: Vec2, speed: number): void {
    this.ball = {
      kind: 'rolling',
      pos: { ...pos },
      vel: scale(norm(velDir), speed),
      controllerId: -1,
    }
  }

  // İlk dokunuş: top teslim alınırken kontrol testi. Sert pas, havadan gelen
  // top ve baskı zorlaştırır; kötü dokunuşta top açılır (kusursuz kontrol yok).
  receiveBall(playerId: number, difficulty: number, at?: Vec2): void {
    const p = this.players[playerId]
    const spot = at ?? (this.ball.kind === 'rolling' ? this.ball.pos : this.ballPos())
    if (p.info.role === 'GK') {
      this.possess(playerId, spot) // kaleci topu elleriyle alır
      return
    }
    const ctl = controlSkill(p.info.attributes)
    // Kolay top (yavaş, yerden, baskısız) neredeyse her zaman temiz alınır;
    // zorluk arttıkça kontrol becerisi belirleyici olur
    const cleanP = Math.max(
      0.4,
      Math.min(0.985, 0.985 - difficulty * 0.65 + (ctl - 0.65) * 0.45),
    )
    if (this.rng.chance(cleanP)) {
      this.possess(playerId, spot)
      // Yönlü ilk dokunuş: top ölü durdurulmaz — gidilecek boş yöne açılır
      // (hücum yönü + en yakın rakipten uzağa). Sert gelen top daha büyük
      // açılır; oyuncu topla birlikte hareket etme şansı bulur.
      if (this.ball.kind === 'rolling' && this.phase.kind === 'open') {
        const fwd = vec(this.attackDir[p.teamIdx], 0)
        let esc = vec(0, 0)
        let nearestOpp = 99
        for (const o of this.active(1 - p.teamIdx)) {
          const d = dist(o.pos, p.pos)
          if (d < nearestOpp) {
            nearestOpp = d
            if (d < 7) esc = norm(sub(p.pos, o.pos))
          }
        }
        const touchDir = norm(add(fwd, scale(esc, 0.9)))
        const touchSpeed = Math.min(3.4, 1.2 + difficulty * 2.2 + this.rng.range(0, 0.6))
        this.ball.vel = scale(touchDir, touchSpeed)
      }
      return
    }
    // Kötü ilk dokunuş: top ayaktan sekip açılır, kapışma doğar
    this.lastTouchTeam = p.teamIdx
    this.lastTouchId = playerId
    const heavy = this.rng.chance(0.75)
    const dir = norm({
      x: this.attackDir[p.teamIdx] * this.rng.range(0.2, 1) + this.rng.range(-0.6, 0.6),
      y: this.rng.range(-1, 1),
    })
    this.looseBall(spot, dir, heavy ? this.rng.range(2.5, 4.5) : this.rng.range(4.5, 7))
    if (!heavy) this.pushEvent('miscontrol', p.teamIdx, playerId)
  }

  // Atalet ile hareket: istenen hız vektörüne yumuşak geçiş yapılır,
  // böylece ani yön/hız sıçramaları (robotik görünüm) engellenir.
  // agility: sprint kovalamalarında yüksek (keskin dönüş), pozisyon tutarken düşük.
  movePlayer(p: PlayerSim, target: Vec2, speed: number, dt: number, agility = 6): number {
    const d = dist(p.pos, target)
    let desired: Vec2
    if (d < 0.05) {
      desired = vec(0, 0)
    } else {
      const eff = d < 2 ? speed * Math.max(0.3, d / 2) : speed
      desired = scale(norm(sub(target, p.pos)), Math.min(eff, d / dt))
    }
    const k = Math.min(1, dt * agility)
    p.vel = {
      x: p.vel.x + (desired.x - p.vel.x) * k,
      y: p.vel.y + (desired.y - p.vel.y) * k,
    }
    const before = { ...p.pos }
    p.pos = add(p.pos, scale(p.vel, dt))
    return dist(before, p.pos)
  }

  // Sert çarpışma çözümü: hiçbir iki oyuncu MIN mesafeden yakın duramaz.
  // Hedef sapması değil pozisyon kuralı — üst üste binme fiziksel olarak
  // imkânsız. Yerde yatan oyuncu itilmez, diğerleri ondan uzaklaşır.
  resolveCollisions(): void {
    const MIN = 2.0
    const act = this.active()
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < act.length; i++) {
        for (let j = i + 1; j < act.length; j++) {
          const a = act[i]
          const b = act[j]
          const dx = b.pos.x - a.pos.x
          const dy = b.pos.y - a.pos.y
          let d = Math.hypot(dx, dy)
          if (d >= MIN) continue
          let ux: number
          let uy: number
          if (d < 1e-6) {
            // Tam üst üste: kimliklerden türetilen determinist yön
            const ang = ((a.id * 37 + b.id * 101) % 360) * (Math.PI / 180)
            ux = Math.cos(ang)
            uy = Math.sin(ang)
            d = 0
          } else {
            ux = dx / d
            uy = dy / d
          }
          // Kontrolcü itilmez: topunu vücuduyla korur (shielding) — yoksa
          // çarpışma onu topundan uzaklaştırıp oyunu kilitler
          const cid = this.controllerId()
          const aDown = (a.id === this.downedId && this.tick < this.downedUntil) || a.id === cid
          const bDown = (b.id === this.downedId && this.tick < this.downedUntil) || b.id === cid
          const overlap = MIN - d
          if (aDown && bDown) continue
          if (aDown) {
            b.pos.x += ux * overlap
            b.pos.y += uy * overlap
          } else if (bDown) {
            a.pos.x -= ux * overlap
            a.pos.y -= uy * overlap
          } else {
            a.pos.x -= ux * (overlap / 2)
            a.pos.y -= uy * (overlap / 2)
            b.pos.x += ux * (overlap / 2)
            b.pos.y += uy * (overlap / 2)
          }
        }
      }
    }
  }

  // --- restart kurulumu ---

  setupRestart(kind: RestartKind, forTeam: number, spot: Vec2, timer: number): void {
    const takerId = this.pickTaker(kind, forTeam, spot)
    this.engagerId = [-1, -1]
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

  // Ofsayt çizgisi: hücum eden takımın çerçevesinde sondan ikinci rakibin
  // derinliği (kendi sahasında ofsayt olmaz → alt sınır orta çizgi)
  offsideLine(attTeam: number): number {
    const xs: number[] = []
    for (const o of this.active(1 - attTeam)) {
      xs.push(this.toAttack(o.pos, attTeam).x)
    }
    xs.sort((a, b) => b - a)
    return Math.max(xs[1] ?? 0, 0)
  }

  // --- uçuş başlatma ---

  launchPass(
    byId: number,
    targetId: number,
    flight: 'pass' | 'cross' = 'pass',
    exemptOffside = false,
  ): void {
    const by = this.players[byId]
    const to = this.players[targetId]
    const from = { ...this.ballPos() }
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
    let passerPressure = 99
    for (const o of this.active(1 - by.teamIdx)) {
      passerPressure = Math.min(passerPressure, dist(o.pos, by.pos))
    }
    if (passerPressure < 5) err *= 1 + (1 - passerPressure / 5) * 0.7
    // Kısa hazırlık pasları teknik olarak kolaydır — hata payı düşük
    if (d0 < 14) err *= 0.5
    // Bozuk pas: baskı ve mesafeyle olasılığı artar (rahat kısa pasta nadir)
    const mishitP = 0.015 + (passerPressure < 3 ? 0.05 : 0) + (d0 > 25 ? 0.03 : 0)
    if (this.rng.chance(mishitP)) err *= 2.5
    const target = {
      x: to.pos.x + lead.x + this.rng.range(-1, 1) * err * d0,
      y: to.pos.y + lead.y + this.rng.range(-1, 1) * err * d0,
    }
    // Ofsayt kontrolü (pas anındaki pozisyona göre)
    let offside = false
    if (!exemptOffside) {
      const line = this.offsideLine(by.teamIdx)
      const recvAttX = this.toAttack(to.pos, by.teamIdx).x
      const ballAttX = this.toAttack(from, by.teamIdx).x
      offside = recvAttX > line + 0.25 && recvAttX > ballAttX && recvAttX > 0
    }

    const d = Math.max(1, dist(from, target))
    // Uzun paslar ve ortalar havadan gider (bloğun üstünden aşar)
    const lofted = flight === 'cross' || d0 > 24
    this.ball = {
      kind: 'inFlight',
      from,
      to: target,
      t: 0,
      // Pas hızı sabit değil: her pasta doğal değişkenlik var
      duration: d / (passSpeed(by.info.attributes) * this.rng.range(0.85, 1.1)),
      flight,
      byId,
      targetId,
      offside,
      hMax: lofted ? Math.min(7, 2 + d * 0.08) : 0,
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
    // Degaj uzun gider: baskıyı gerçekten rahatlatır
    const target = {
      x: Math.min(HALF_LENGTH - 3, Math.max(-HALF_LENGTH + 3, from.x + dir * this.rng.range(26, 48))),
      y: Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, from.y + this.rng.range(-16, 16))),
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
      hMax: 3 + d * 0.07, // degaj daima havadan
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
    // Kullanıcı zaten yürüyerek geldi; en fazla küçük bir düzeltme olur
    if (dist(taker.pos, spot) > 2.5) taker.pos = { ...spot }

    if (restart === 'kickoff') {
      const mates = this.active(forTeam).filter((p) => p.id !== takerId)
      mates.sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot))
      this.pushEvent('kickoff', forTeam, takerId)
      if (mates[0]) this.launchPass(takerId, mates[0].id, 'pass', true)
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
        hMax: 4 + d * 0.06, // korner ortası havadan
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
    this.possess(takerId, spot)
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
    // Taç, kale vuruşu ve santradan ofsayt olmaz
    if (best) this.launchPass(takerId, best.id, 'pass', restart !== 'free_kick')
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

    // Faul okunur olsun: düdükte herkes kısa an durur, faul yiyen yerde kalır
    this.freezeUntil = this.tick + 9
    this.downedId = victimId
    this.downedUntil = this.tick + 22
    victim.vel = vec(0, 0)

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

    // İlk dokunuş zorluğu: pasın hızı, havadan gelişi ve alıcıdaki baskı
    const flightSpeed = dist(this.ball.from, this.ball.to) / Math.max(0.1, this.ball.duration)
    const lofted = (this.ball.hMax ?? 0) > 0

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

    // Dar varış yarıçapı: uzak kalan yetişemez, top kısa süre boşa düşer ve
    // doğal bir kapışma çıkar (ışınlanma yok). Markajcılar adamlarının 1.4 m
    // dibinde durduğu için varışlara doğal olarak ortak olurlar.
    // Çarpışma tabanı 2.0 m: savunmacı alıcının dibine giremez, bu yüzden
    // çekişme yarıçapı daha geniş tutulur ama alıcı avantajlıdır (top ona
    // doğru oynanmıştır)
    const attClose = att !== null && attD < 2.2
    const defClose = def !== null && defD < 2.7

    const baseDifficulty =
      Math.max(0, (flightSpeed - 13) * 0.04) + (lofted ? 0.3 : 0) + (defClose ? 0.25 : 0)

    if (attClose && defClose && att && def) {
      // Çekişmeli varış: yakınlık + pozisyon alma becerisi
      const wa = (2.2 - attD) * interceptSkill(att.info.attributes)
      const wd = (2.7 - defD) * interceptSkill(def.info.attributes) * 0.55
      if (this.rng.next() < wa / (wa + wd)) {
        this.receiveBall(att.id, baseDifficulty)
        this.passesCompleted[by.teamIdx]++
      } else {
        this.pushEvent('interception', def.teamIdx, def.id)
        this.receiveBall(def.id, baseDifficulty + 0.2)
      }
      return
    }
    if (attClose && att) {
      this.receiveBall(att.id, baseDifficulty)
      this.passesCompleted[by.teamIdx]++
      return
    }
    if (defClose && def) {
      this.pushEvent('interception', def.teamIdx, def.id)
      this.receiveBall(def.id, baseDifficulty + 0.2)
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
    // Düdük anı: kısa bir donma — faul/penaltı algılanabilir olur
    if (this.tick < this.freezeUntil) {
      this.phase.timer--
      return
    }
    for (const p of this.active()) {
      if (p.id === this.downedId && this.tick < this.downedUntil) {
        p.vel = vec(0, 0)
        continue
      }
      const t = this.restartTargets[p.id]
      let target =
        t ??
        targetPosition(
          this.slotOf(p),
          this.attackDir[p.teamIdx],
          this.phase.spot,
          p.teamIdx === this.phase.forTeam,
        )
      if (p.id !== this.phase.takerId && p.info.role !== 'GK') {
        target = add(target, this.separation(p))
      }
      const spd = maxSpeed(p.info.attributes) * energyFactor(p.energy) * 0.85
      this.movePlayer(p, target, spd, dt)
    }
    this.resolveCollisions()
    this.phase.timer--
    if (this.phase.timer <= 0) {
      // Kullanıcı topun başına gelene kadar bekle (makul bir üst sınırla)
      const taker = this.players[this.phase.takerId]
      if (dist(taker.pos, this.phase.spot) < 2.6 || this.phase.timer < -60) {
        this.executeRestart()
      }
    }
  }

  stepOpen(dt: number): void {
    // 1) Top durumu
    if (this.ball.kind === 'inFlight') {
      this.stepInFlight(dt)
    } else {
      this.stepRolling(dt)
    }

    // 2) Oyuncu hareketi (top yeni duruma geçmiş olabilir)
    if (this.phase.kind === 'open') this.movePlayers(dt)
  }

  // Yerdeki topun fizik adımı. Top HER ZAMAN kendi hız/sürtünmesiyle
  // yuvarlanır; kontrolcü ona yetişip ayağına aldığında oynar. Top sürme =
  // topa gerçek vuruşlar yapıp kovalamak — top asla oyuncuya geri "çekilmez".
  stepRolling(dt: number): void {
    if (this.ball.kind !== 'rolling') return
    const b = this.ball

    // Fizik: yuvarlanma + çim sürtünmesi
    b.pos = add(b.pos, scale(b.vel, dt))
    b.vel = scale(b.vel, Math.max(0, 1 - 1.7 * dt))

    if (Math.abs(b.pos.y) > HALF_WIDTH || Math.abs(b.pos.x) > HALF_LENGTH) {
      this.outOfBounds(b.pos)
      return
    }

    if (b.controllerId >= 0 && this.players[b.controllerId].sentOff) b.controllerId = -1

    // Boştaki top: kapma kontesti (kontrol testiyle; hızlı top zor durur).
    // Yarıçap 1.3: çarpışma tabanı (2.0) topun iki yanında kilitlenen iki
    // oyuncunun da erişebilmesine izin verir — kura çözer.
    if (b.controllerId < 0) {
      const ballSpeed = Math.hypot(b.vel.x, b.vel.y)
      const pickupDifficulty = ballSpeed < 2.5 ? 0 : (ballSpeed - 2.5) * 0.1
      const contenders = this.active().filter((p) => dist(p.pos, b.pos) < 1.3)
      if (contenders.length === 1) {
        this.receiveBall(contenders[0].id, pickupDifficulty)
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
            this.receiveBall(contenders[i].id, pickupDifficulty + 0.2)
            break
          }
        }
      }
      return
    }

    const carrier = this.players[b.controllerId]
    const opponents = this.active(1 - carrier.teamIdx)
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
          b.pos,
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

    // Karar zamanı mı? Yalnız top ayaktayken (oyuncu fiziksel topa yetişmişse)
    const ballSpeedNow = Math.hypot(b.vel.x, b.vel.y)
    if (dBall < 1.6 && ballSpeedNow < 3.5 && this.tick >= this.nextDecisionTick) {
      const mates = this.active(carrier.teamIdx)
      if (carrier.info.role === 'GK') {
        this.gkDistribute(carrier, mates, opponents)
        return
      }
      // Kontra penceresi: top yeni kazanıldıysa hızlı ve dikine oyna
      const counter =
        this.tick - this.lastTurnover.tick < 30 && carrier.teamIdx === this.lastTurnover.team
      const decision: Decision = decide(
        carrier,
        mates,
        opponents,
        this.attackDir[carrier.teamIdx],
        this.rng,
        counter,
      )
      this.nextDecisionTick = this.tick + (counter ? 6 : 8)
      if (decision.kind === 'pass') {
        this.launchPass(carrier.id, decision.targetId)
        return
      }
      if (decision.kind === 'cross') {
        this.launchPass(carrier.id, decision.targetId, 'cross')
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
      // dribble: yön belirle, hafif gürültü; sürüşe kararlı bağlan —
      // oyuncu topu gerçekten taşısın, yarım adımda vazgeçmesin
      const noisy = norm({
        x: decision.dir.x + this.rng.range(-0.25, 0.25),
        y: decision.dir.y + this.rng.range(-0.35, 0.35),
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
          if (this.rng.chance(pWin)) {
            opp.tackleCooldown = Math.max(opp.tackleCooldown, 1.3) // ekarte
          } else if (this.rng.chance(0.08)) {
            this.handleFoul(opp.id, carrier.id) // çalım faul kazandırdı
            return
          } else {
            opp.tackleCooldown = Math.max(opp.tackleCooldown, 0.5)
            this.pushEvent('tackle', opp.teamIdx, opp.id, carrier.id)
            if (this.rng.chance(0.5)) {
              this.possess(opp.id)
            } else {
              this.looseBall(
                carrier.pos,
                { x: this.rng.range(-1, 1), y: this.rng.range(-1, 1) },
                this.rng.range(2, 5),
              )
              this.lastTouchTeam = opp.teamIdx
              this.lastTouchId = opp.id
            }
            return
          }
        }
      }

      // VURUŞ: topa gerçek impuls — top öne yuvarlanır, oyuncu kovalar,
      // yetişince tekrar oynar. Ağır dokunuş topu fazla açar (kontrolü
      // kötü oyuncuda daha sık) ve rakip araya girebilir.
      carrier.dribbleDir = noisy
      const heavyP = 0.14 * (1.5 - controlSkill(carrier.info.attributes))
      const kick = this.rng.chance(heavyP) ? this.rng.range(6.5, 8.5) : this.rng.range(4.2, 6)
      b.vel = scale(noisy, kick)
      this.lastTouchTeam = carrier.teamIdx
      this.lastTouchId = carrier.id
      this.nextDecisionTick = this.tick + 3
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
    const pos = this.flightPos(b)

    if (b.flight === 'shot') {
      if (b.t >= 1 || Math.abs(pos.x) >= HALF_LENGTH - 0.1) {
        this.resolveShotArrival()
      }
      return
    }

    // Ofsayt: varışta düdük çalınır (alıcı koşusunu tamamlar, doğal görünür)
    if (b.offside && b.t >= 1) {
      const passTeam = this.players[b.byId].teamIdx
      const defTeam = 1 - passTeam
      this.offsides[passTeam]++
      this.pushEvent('offside', passTeam, b.targetId ?? b.byId)
      const spot = {
        x: Math.max(-HALF_LENGTH + 2, Math.min(HALF_LENGTH - 2, b.to.x)),
        y: Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, b.to.y)),
      }
      this.setupRestart('free_kick', defTeam, spot, 20)
      return
    }

    // Topun anlık yüksekliği (parabolik): havadaki topa ayak uzanmaz
    const height = 4 * (b.hMax ?? 0) * b.t * (1 - b.t)

    // Uçuş ortası araya girme (paslar/ortalar) — yolun ilk çeyreği hariç ve
    // yalnız top erişilebilir yükseklikteyken. Ofsayt pasına savunma dokunmaz.
    if (!b.offside && b.t > 0.25 && b.t < 0.95 && height < 2) {
      const passingTeam = this.players[b.byId].teamIdx
      for (const o of this.active(1 - passingTeam)) {
        if (dist(o.pos, pos) < 0.8 && this.rng.chance(0.08 * interceptSkill(o.info.attributes))) {
          this.pushEvent('interception', o.teamIdx, o.id)
          this.receiveBall(o.id, 0.45) // uçan topu kesmek zor kontrol edilir
          return
        }
      }
    }
    // Kaleci ortayı havada toplayabilir
    if (!b.offside && b.flight === 'cross' && b.t > 0.5 && height < 3) {
      const gk = this.keeperOf(1 - this.players[b.byId].teamIdx)
      if (gk && dist(gk.pos, pos) < 2.2 && this.rng.chance(0.4)) {
        this.possess(gk.id)
        this.pushEvent('interception', gk.teamIdx, gk.id)
        return
      }
    }

    // Saha dışına mı gidiyor?
    if (Math.abs(pos.y) > HALF_WIDTH || Math.abs(pos.x) > HALF_LENGTH) {
      this.outOfBounds(pos)
      return
    }

    if (b.t >= 1) this.resolvePassArrival()
  }

  // FM tarzı görev sistemi: topa takım başına TEK oyuncu gider (first
  // defender). Aday seçimi maliyete dayanır: mesafe + rolün doğal bölgesine
  // uygunluk (DF geride, MF ortada, FW ileride karşılar). Histerezis, görevin
  // her tick el değiştirmesini önler; böylece "hep aynı iki oyuncu koşuyor"
  // görüntüsü de, sürü halinde topa gitme de biter.
  assignEngager(teamIdx: number, focus: Vec2, maxRange: number, allowGk = false): number {
    const focusAtt = this.toAttack(focus, teamIdx)
    let bestId = -1
    let bestCost = Infinity
    for (const p of this.active(teamIdx)) {
      if (p.info.role === 'GK' && !allowGk) continue
      const d = dist(p.pos, focus)
      if (d > maxRange) continue
      // Santraforlar baskıya isteksizdir: yalnız çok yüksek toplara giderler
      const depthPref = p.info.role === 'DF' ? -22 : p.info.role === 'MF' ? -2 : 26
      let cost = d + Math.abs(focusAtt.x - depthPref) * 0.22
      // Kademe: kale tarafındaki aday tercih edilir — arkadan kovalayan
      // varken önden biri ÇIKAR, hat kaleye kadar geri kaçmaz
      const pAtt = this.toAttack(p.pos, teamIdx)
      if (pAtt.x > focusAtt.x) cost += 6
      // Çalım yemiş / müdahalesi boşa çıkmış oyuncu görevden düşer:
      // kademedeki oyuncu birinci adam olarak devralır
      if (p.tackleCooldown > 0.4) cost += 9
      if (p.id === this.engagerId[teamIdx]) cost *= 0.72
      if (cost < bestCost) {
        bestCost = cost
        bestId = p.id
      }
    }
    this.engagerId[teamIdx] = bestId
    return bestId
  }

  // Takım arkadaşlarından ayrışma: 2 m'den yakına giren oyuncular birbirini
  // yumuşakça iter — üst üste binme olmaz. Rakiplere uygulanmaz (müdahale
  // teması gerekli).
  separation(p: PlayerSim): Vec2 {
    let sx = 0
    let sy = 0
    // Takım arkadaşları: 2 m mesafe korunur
    for (const q of this.active(p.teamIdx)) {
      if (q.id === p.id) continue
      const d = dist(p.pos, q.pos)
      if (d < 2 && d > 1e-6) {
        const push = (2 - d) * 1.3
        sx += ((p.pos.x - q.pos.x) / d) * push
        sy += ((p.pos.y - q.pos.y) / d) * push
      }
    }
    // Rakipler: görevli (müdahale için temas gerekir) ve topu taşıyan hariç,
    // ~1.2 m mesafe korunur — çekişme anlarında üst üste binme olmaz
    if (p.id !== this.engagerId[p.teamIdx]) {
      const carrierId = this.controllerId()
      for (const q of this.active(1 - p.teamIdx)) {
        if (q.id === carrierId) continue
        const d = dist(p.pos, q.pos)
        if (d < 1.2 && d > 1e-6) {
          const push = (1.2 - d) * 0.9
          sx += ((p.pos.x - q.pos.x) / d) * push
          sy += ((p.pos.y - q.pos.y) / d) * push
        }
      }
    }
    const l = Math.hypot(sx, sy)
    if (l > 2.5) {
      sx = (sx / l) * 2.5
      sy = (sy / l) * 2.5
    }
    return { x: sx, y: sy }
  }

  movePlayers(dt: number): void {
    const bp = this.ballPos()
    const possTeam = this.possTeam()
    const carrierId = this.controllerId()

    // Görev atamaları (FM modeli): topa yalnız görevli gider, bir oyuncu
    // arkasını alır, kalanlar markaj yapar ya da şekli korur.
    const overrides = new Map<number, { target: Vec2; sprint: boolean }>()
    let defTeam = -1

    if (carrierId >= 0) {
      const carrier = this.players[carrierId]
      defTeam = 1 - carrier.teamIdx
      const ballAttDef = this.toAttack(bp, defTeam)
      // Top kendi yarı sahasına yaklaştıysa sert angajman; rakip sahadaysa
      // mesafeli karşılama (bekler, dalmaz) — full saha pres yok
      const aggressive = ballAttDef.x < 8
      const engager = this.assignEngager(defTeam, carrier.pos, aggressive ? 24 : 15)
      if (engager >= 0) {
        const e = this.players[engager]
        const d = dist(e.pos, carrier.pos)
        if (aggressive) {
          const t =
            d > 2.5 ? add(carrier.pos, this.fromAttack({ x: -1.5, y: 0 }, defTeam)) : carrier.pos
          overrides.set(engager, { target: t, sprint: true })
        } else {
          // top ile kendi kalesi arasında pozisyon alıp bekler; forvetse
          // daha da mesafeli durur (isteksiz baskı)
          const standDist = e.info.role === 'FW' ? -4.5 : -3.2
          const stand = add(carrier.pos, this.fromAttack({ x: standDist, y: 0 }, defTeam))
          overrides.set(engager, { target: stand, sprint: d > 7 })
        }
        // Kutu acil durumu: top kendi ceza sahasındaysa ikinci adam da topa
        // gider (kutuda seyredilmez); değilse ikinci adam cover pozisyonu alır
        const inOwnBox =
          ballAttDef.x < -HALF_LENGTH + PENALTY_AREA_DEPTH &&
          Math.abs(ballAttDef.y) < PENALTY_AREA_WIDTH / 2 + 3
        let second: PlayerSim | null = null
        let secondD = inOwnBox ? 12 : 14
        for (const q of this.active(defTeam)) {
          if (q.id === engager || q.info.role === 'GK') continue
          const dd = dist(q.pos, carrier.pos)
          if (dd < secondD) {
            secondD = dd
            second = q
          }
        }
        if (second) {
          if (inOwnBox) {
            overrides.set(second.id, { target: carrier.pos, sprint: true })
          } else {
            // Kademe: ikinci adam top ile KENDİ KALESİ arasındaki hat üzerinde,
            // görevlinin ~5.5 m gerisinde açıyla durur — görevli geçilirse
            // önünde o var
            const ownGoal = vec(-HALF_LENGTH * this.attackDir[defTeam], 0)
            const coverPoint = add(
              carrier.pos,
              scale(norm(sub(ownGoal, carrier.pos)), 5.5),
            )
            overrides.set(second.id, { target: coverPoint, sprint: false })
          }
        }
      }

      // Pas açısı desteği: taşıyıcı baskı altındaysa en yakın iki takım
      // arkadaşı kısa pas seçeneği yaratacak açılara iner (boşa çıkma)
      let nearestDef = 99
      for (const q of this.active(defTeam)) {
        nearestDef = Math.min(nearestDef, dist(q.pos, carrier.pos))
      }
      if (nearestDef < 4) {
        const goalDir = norm(
          sub(vec(HALF_LENGTH * this.attackDir[carrier.teamIdx], 0), carrier.pos),
        )
        const perp = vec(-goalDir.y, goalDir.x)
        const back = add(carrier.pos, scale(goalDir, -3))
        const s1 = add(back, scale(perp, 9))
        const s2 = add(back, scale(perp, -9))
        const mates = this.active(carrier.teamIdx)
          .filter((m) => m.id !== carrier.id && m.info.role !== 'GK')
          .sort((a, b) => dist(a.pos, carrier.pos) - dist(b.pos, carrier.pos))
          .slice(0, 2)
        if (mates[0]) {
          const first = dist(mates[0].pos, s1) <= dist(mates[0].pos, s2) ? s1 : s2
          overrides.set(mates[0].id, { target: first, sprint: false })
          if (mates[1]) {
            overrides.set(mates[1].id, { target: first === s1 ? s2 : s1, sprint: false })
          }
        }
      }
    } else if (this.ball.kind === 'inFlight' && this.ball.flight !== 'shot') {
      const b = this.ball
      defTeam = 1 - this.players[b.byId].teamIdx
      // Pas hedefindeki oyuncu topun varış noktasına koşar
      if (b.targetId !== null && !this.players[b.targetId].sentOff) {
        overrides.set(b.targetId, { target: b.to, sprint: true })
      }
      // Savunmadan yalnız yetişebilecek TEK görevli iniş noktasına gider
      const remaining = Math.max(0, 1 - b.t) * b.duration
      const reach = remaining * 7.5 + 5
      const engager = this.assignEngager(defTeam, b.to, reach)
      if (engager >= 0) overrides.set(engager, { target: b.to, sprint: true })
      // Alıcının markajcısı adamıyla birlikte topa gider: alıcıya en yakın
      // savunmacı da iniş noktasına koşar (adam takibi — sürü değil)
      if (b.targetId !== null) {
        const recv = this.players[b.targetId]
        let tracker: PlayerSim | null = null
        let trackerD = 8
        for (const q of this.active(defTeam)) {
          if (q.info.role === 'GK' || q.id === engager) continue
          const dd = dist(q.pos, recv.pos)
          if (dd < trackerD) {
            trackerD = dd
            tracker = q
          }
        }
        if (tracker) {
          // Görevliyle aynı noktaya yığılmasın: yakınsa kale tarafına açılır
          const peel =
            engager >= 0 && dist(tracker.pos, this.players[engager].pos) < 3
              ? this.fromAttack({ x: -2.2, y: 0 }, defTeam)
              : vec(0, 0)
          overrides.set(tracker.id, { target: add(b.to, peel), sprint: true })
        }
      }
      // Degaj/uzun top (hedefsiz): hücum eden taraftan da tek oyuncu gider
      if (b.targetId === null) {
        const att = this.assignEngager(1 - defTeam, b.to, 30)
        if (att >= 0) overrides.set(att, { target: b.to, sprint: true })
      }
    } else if (this.ball.kind === 'rolling') {
      // Boş top: takım başına yalnız en uygun TEK oyuncu (kendi ceza
      // sahasındaysa kaleci de aday)
      const chase = add(bp, scale(this.ball.vel, 0.3))
      for (let t = 0; t < 2; t++) {
        const att = this.toAttack(bp, t)
        const inOwnBox =
          att.x < -HALF_LENGTH + PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
        const engager = this.assignEngager(t, chase, 28, inOwnBox)
        if (engager >= 0) overrides.set(engager, { target: chase, sprint: true })
      }
    }

    // Son adam kuralı: savunma hattı en derine sarkan TOPSUZ rakip koşucuyu
    // takip eder. Topu süren oyuncu hesaba katılmaz — o geri kaçılarak değil,
    // önden çıkan görevliyle KARŞILANIR (kademe mantığı)
    let deepestThreat = 99
    if (defTeam >= 0) {
      for (const o of this.active(1 - defTeam)) {
        if (o.info.role === 'GK' || o.id === carrierId) continue
        deepestThreat = Math.min(deepestThreat, this.toAttack(o.pos, defTeam).x)
      }
    }

    // Hücumdaki takımın ofsayt çizgisi (topsuz hücumcular gerisinde kalır)
    const onsideLine = possTeam >= 0 ? this.offsideLine(possTeam) : 99

    // Adam adama markaj: savunan DF/MF'ler bölgesindeki boştaki rakibi kale
    // tarafından tutar; görevliler hariç, rakip başına tek markajcı
    const markTargets = new Map<number, Vec2>()
    if (defTeam >= 0) {
      const marked = new Set<number>()
      const oppList = this.active(1 - defTeam).filter((o) => o.id !== carrierId)
      for (const d of this.active(defTeam)) {
        if (d.info.role !== 'DF' && d.info.role !== 'MF') continue
        if (overrides.has(d.id)) continue
        const zonal = targetPosition(this.slotOf(d), this.attackDir[d.teamIdx], bp, false)
        let best: PlayerSim | null = null
        let bestD = 12
        for (const o of oppList) {
          if (marked.has(o.id)) continue
          const dd = dist(o.pos, zonal)
          if (dd < bestD) {
            bestD = dd
            best = o
          }
        }
        if (best) {
          marked.add(best.id)
          // Pas hattını kapatan markaj: adamın top tarafında + hafif kale
          // tarafında dur (top ayağına gelmesin)
          const toBall = norm(sub(bp, best.pos))
          const goalSide = this.fromAttack({ x: -0.8, y: 0 }, defTeam)
          let mt = add(add(best.pos, scale(toBall, 1.2)), goalSide)
          if (dist(mt, zonal) > 8) {
            mt = add(zonal, scale(norm(sub(mt, zonal)), 8))
          }
          markTargets.set(d.id, mt)
        }
      }
    }

    const ballVel = this.ball.kind === 'rolling' ? this.ball.vel : vec(0, 0)
    // Defanstan çıkış tespiti: topu kontrol eden takım kendi üçte birinde
    const ballAttPoss = possTeam >= 0 ? this.toAttack(bp, possTeam) : null
    const buildUp = ballAttPoss !== null && ballAttPoss.x < -18

    for (const p of this.active()) {
      let target: Vec2
      let sprint = false
      const ov = overrides.get(p.id)

      // Faulle yerde kalan oyuncu kalkana kadar hareket etmez
      if (p.id === this.downedId && this.tick < this.downedUntil) {
        p.vel = vec(0, 0)
        continue
      }

      if (p.id === carrierId) {
        const dB = dist(p.pos, bp)
        if (dB > 1.0) {
          // Topunu kovala: vuruştan sonra topun duracağı noktaya koş
          target = add(bp, scale(ballVel, 0.3))
          sprint = true
        } else if (p.dribbleDir) {
          target = add(p.pos, scale(p.dribbleDir, 3))
        } else {
          // Alım anı: ani durmaz, momentumuyla süzülerek yavaşlar
          p.vel = scale(p.vel, Math.max(0, 1 - 2.8 * dt))
          p.pos = add(p.pos, scale(p.vel, dt))
          continue
        }
      } else if (ov) {
        target = ov.target
        sprint = ov.sprint
      } else if (markTargets.has(p.id)) {
        // Markajcı adamına yapışık kalır — son adam kuralı ona uygulanmaz
        target = markTargets.get(p.id) as Vec2
      } else {
        target = targetPosition(this.slotOf(p), this.attackDir[p.teamIdx], bp, possTeam === p.teamIdx)

        // Hücumdaki oyuncu ofsayt çizgisinin gerisinde kalır (çizgi dansı)
        if (p.teamIdx === possTeam && p.id !== carrierId) {
          const attT = this.toAttack(target, p.teamIdx)
          if (attT.x > onsideLine - 0.4) {
            target = this.fromAttack({ x: onsideLine - 0.4, y: attT.y }, p.teamIdx)
          }
        }

        // Defanstan çıkış düzeni: sahayı büyüt. Stoperler ceza sahası
        // genişliğine açılır, bekler yüksek ve geniş çıkar, pivot topun
        // önünde ilk pas hattına iner, kanatlar geniş kalır — kısa pas
        // açıları doğar, pres kırılır.
        if (
          buildUp &&
          ballAttPoss &&
          p.teamIdx === possTeam &&
          p.id !== carrierId &&
          p.info.role !== 'GK' &&
          p.info.role !== 'FW'
        ) {
          const slot = this.slotOf(p)
          let att = this.toAttack(target, p.teamIdx)
          if (p.info.role === 'DF') {
            if (Math.abs(slot.width) >= 0.5) {
              // bek: yüksek ve geniş
              att = { x: Math.max(att.x, ballAttPoss.x + 10), y: Math.sign(slot.width) * 23 }
            } else {
              // stoper: genişliğe açıl, topla aynı hatta kal
              const side = slot.width !== 0 ? Math.sign(slot.width) : p.slotIdx % 2 ? 1 : -1
              att = { x: Math.min(att.x, ballAttPoss.x + 6), y: side * 14 }
            }
          } else if (Math.abs(slot.width) < 0.35) {
            // pivot / merkez orta saha: topun önünde kademeli pas hattı
            att = {
              x: ballAttPoss.x + 8 + Math.abs(slot.width) * 20,
              y: att.y * 0.4,
            }
          } else {
            // kanat orta saha: geniş kal, sahayı yay
            att = { x: att.x, y: Math.sign(slot.width) * Math.max(Math.abs(att.y), 22) }
          }
          target = this.fromAttack(att, p.teamIdx)
        }

        // Son adam kuralı (yalnız bölge tutan DF'ler): hattın arkasında
        // koşucu bırakılmaz — en derin rakipten önde durulamaz
        if (p.teamIdx === defTeam && p.info.role === 'DF' && deepestThreat < -5) {
          const attT = this.toAttack(target, p.teamIdx)
          const floor = Math.max(deepestThreat - 1, -HALF_LENGTH + 5)
          if (attT.x > floor) {
            target = this.fromAttack({ x: floor, y: attT.y }, p.teamIdx)
          }
        }

        // Kademeli hat: toptan uzak kanattaki savunmacılar biraz derine
        // kademelenir — hat düz bir çizgi değil, çapraz bir merdiven olur
        if (p.teamIdx === defTeam && p.info.role === 'DF') {
          const latDist = Math.abs(target.y - bp.y)
          const drop = Math.min(3, Math.max(0, latDist - 8) * 0.15)
          if (drop > 0) {
            const attT = this.toAttack(target, p.teamIdx)
            target = this.fromAttack({ x: attT.x - drop, y: attT.y }, p.teamIdx)
          }
        }
      }

      // Üst üste binmeyi önleyen ayrışma (taşıyıcı ve kaleci hariç)
      if (p.id !== carrierId && p.info.role !== 'GK') {
        target = add(target, this.separation(p))
      }

      // Enerji tasarrufu: pozisyon tutarken tempolu yürüyüş/hafif koşu;
      // yalnız hedefinden iyice kopan oyuncu tam koşar
      const far = !sprint && dist(p.pos, target) > 10
      // Taşıyıcı: topu kovalarken hızlı, ayakta oynarken kısık — vur-kaç
      // ritmi fizikten kendiliğinden doğar
      const carrierFactor = p.id === carrierId ? (sprint ? 0.92 : 0.6) : 1
      const spd =
        maxSpeed(p.info.attributes) *
        energyFactor(p.energy) *
        (sprint || far ? 1 : 0.7) *
        carrierFactor
      const moved = this.movePlayer(p, target, spd, dt, sprint ? 14 : 6)

      p.energy = Math.max(0.35, p.energy - moved * drainPerMeter(p.info.attributes))
      if (moved < 0.1 * dt * spd) p.energy = Math.min(1, p.energy + 0.002 * dt)
    }

    this.resolveCollisions()
  }

  ballHeight(): number {
    if (this.ball.kind !== 'inFlight') return 0
    return 4 * (this.ball.hMax ?? 0) * Math.min(1, this.ball.t) * (1 - Math.min(1, this.ball.t))
  }

  recordFrame(): void {
    const o = this.tick * FRAME_STRIDE
    const f = this.frames
    const bp = this.ballPos()
    let label = -1
    const cid = this.controllerId()
    label = cid >= 0 ? cid : this.lastTouchId
    f[o + F_CLOCK] = this.clockDisplay()
    f[o + F_LABEL] = label
    f[o + F_POSS_TEAM] = this.possTeam()
    f[o + F_BALL_X] = bp.x
    f[o + F_BALL_Y] = bp.y
    f[o + F_REF_X] = this.refPos.x
    f[o + F_REF_Y] = this.refPos.y
    f[o + F_POSS_HOME] = this.possTicks[0]
    f[o + F_POSS_AWAY] = this.possTicks[1]
    f[o + F_BALL_H] = this.ballHeight()
    f[o + F_DOWN] = this.tick < this.downedUntil ? this.downedId : -1
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
      offsides: [...this.offsides],
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
