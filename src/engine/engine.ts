import {
  F_BALL_H,
  F_BALL_X,
  F_BALL_Y,
  F_CLOCK,
  F_DOWN,
  F_ENERGY,
  F_LABEL,
  F_PLAYERS,
  F_POSS_AWAY,
  F_POSS_HOME,
  F_POSS_TEAM,
  F_REF_X,
  F_REF_Y,
  ET_SECONDS,
  FRAME_STRIDE,
  HALF_LENGTH,
  HALF_SECONDS,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
  TICK_DT,
  TICKS_PER_SEC,
} from './constants'
import { controlSkill, maxSpeed } from './attributes'
import {
  aerobicDrain,
  aerobicRecover,
  energyCeiling,
  enginePace,
  sharpness,
} from './stamina'
import { FORMATIONS } from './formations'
import { createRng, type Rng } from './rng'
import { moveReferee } from './referee'
import { add, dist, lerp, norm, scale, sub, vec } from './vec'
import { buildHighlights } from './highlights'
import { BALANCED_TACTICS } from './types'
import * as restarts from './restarts'
import * as discipline from './discipline'
import * as onball from './onball'
import * as offball from './offball'
import * as shootoutMod from './shootout'
import type { ShotOutcome } from './shooting'
import type {
  BallState,
  FormationSlot,
  MatchEvent,
  MatchEventKind,
  MatchResult,
  MatchStats,
  Phase,
  PlayerInfo,
  PlayerSim,
  RestartKind,
  ShootoutKick,
  SubRecord,
  TeamInfo,
  TeamTactics,
  Vec2,
} from './types'

// Normal maç kapasitesi (90' + bol uzatma payı). Elemeli maçta uzatma + penaltı
// serisi için ek pay: 2×15' uzatma + duraklamalar + seri.
const REG_MAX_TICKS = 2 * (HALF_SECONDS + 8 * 60) * TICKS_PER_SEC
const KO_MAX_TICKS = REG_MAX_TICKS + (2 * (ET_SECONDS + 3 * 60) + 8 * 60) * TICKS_PER_SEC

// Maç durumu + çekirdek yardımcılar. Alt sistemler ayrı modüllerde yaşar ve
// durumu bu sınıf üzerinden işletir (restarts/discipline/onball/offball/
// shootout); modüller birbirini DOĞRUDAN import etmez, tüm çaprazlar buradaki
// ince delege metotlardan geçer — döngüsel bağımlılık oluşmaz.
export class MatchSim {
  rng: Rng
  teams: [TeamInfo, TeamInfo]
  players: PlayerSim[] = []
  attackDir: [1 | -1, 1 | -1] = [1, -1]
  ball: BallState = { kind: 'rolling', pos: vec(0, 0), vel: vec(0, 0), controllerId: -1 }
  phase: Phase = { kind: 'open' }
  restartTargets: (Vec2 | null)[] = []
  engagerId: [number, number] = [-1, -1] // takım başına topa giden görevli (histerezis)
  // Topsuz koşu görevleri: biri bloklar arası cebe iner ('pocket'), diğeri
  // savunma hattına yapışıp ARKAYA fırlamak için çizgide sürer ('behind');
  // koşu penceresi ~3.5 sn sürer, sonra tazelenir
  pocketRun: {
    team: number
    ids: [number, number]
    lanes: [number, number]
    modes: ['pocket' | 'behind', 'pocket' | 'behind']
    until: number
    gamble: boolean // derin koşucu çizginin ÜSTÜNE erken fırlar (ofsayt riski)
  } = {
    team: -1,
    ids: [-1, -1],
    lanes: [0, 0],
    modes: ['pocket', 'pocket'],
    until: 0,
    gamble: false,
  }
  // İkili paslaşma (ver-kaç / duvar pası): kısa pası atan oyuncu topu
  // verdikten sonra öne fırlar; alıcı geri pası önceler. Pencere ~2.4 sn.
  oneTwo: { passerId: number; receiverId: number; team: number; until: number } | null = null
  lastTurnover = { tick: -999, team: -1 } // kontra penceresi takibi
  // Gol sevinci: golden sonra santradan önce kısa kutlama penceresi
  celebrateUntil = -1
  celebrateTeam = -1
  celebrateScorerId = -1
  celebrateCorner: Vec2 = vec(0, 0)
  celebrateSnapped = false
  downedId = -1 // faulle yerde kalan oyuncu
  downedUntil = -1
  freezeUntil = -1 // düdük sonrası herkesin durduğu an
  // Yerden pas niyeti: top fiziksel yuvarlanırken kim kime oynadı
  passIntent: {
    byId: number
    targetId: number
    team: number
    offside: boolean
    tick: number // vuruş anı: savunmanın pasa tepkisi gecikmeli başlar
  } | null = null
  half: 1 | 2 | 3 | 4 = 1 // 1-2 normal, 3-4 uzatma
  knockout = false // elemeli: beraberlikte uzatma + penaltı serisi
  // Penaltı serisi durumu (yalnız elemeli maçta 120' beraberliğinde)
  soActive = false
  soScore: [number, number] = [0, 0]
  soKicks: [number, number] = [0, 0] // takım başına atılan penaltı
  soTeamTurn = 0 // sıradaki vuruşu yapacak takım
  soOrder: [number[], number[]] = [[], []] // takım başına vurucu sırası (id)
  soResults: ShootoutKick[] = []
  soWinner = -1
  soPin: { id: number; pos: Vec2 }[] = [] // seri sırasında yerinde tutulanlar
  halfClock = 0
  stoppage = 0
  tick = 0
  finished = false
  score: [number, number] = [0, 0]
  possTicks: [number, number] = [0, 0]
  lastTouchTeam = 0
  lastTouchId = 0
  // Bir pası az önce atan oyuncu, top henüz kendi ayağının dibindeyken onu
  // aynı an geri kapamasın diye kısa bir ayrışma penceresi (bkz. stepRolling)
  justKickedId = -1
  justKickedTick = -1
  // Kaleci oyun kurarken: takım açılana kadar topu tutabileceği son tick.
  // possess() içinde kaleci topu alınca kurulur; gkDistribute bu sınıra
  // kadar (baskı yoksa ve iyi bir açı yoksa) dağıtımı erteler.
  gkHoldUntil = 0
  nextDecisionTick = 0
  refPos: Vec2 = vec(-10, -HALF_WIDTH + 6)
  pendingShot: ShotOutcome | null = null
  // Kaleci şutu okuyup hedefe atlar: reaksiyon gecikmesi geçene kadar
  // normal pozisyon takibinde kalır, sonra bu hedefe sprint override eder.
  keeperDive: { keeperId: number; to: Vec2; readyTick: number } | null = null
  events: MatchEvent[] = []
  maxTicks = REG_MAX_TICKS
  frames: Float32Array
  shots: [number, number] = [0, 0]
  shotsOnTarget: [number, number] = [0, 0]
  corners: [number, number] = [0, 0]
  fouls: [number, number] = [0, 0]
  offsides: [number, number] = [0, 0]
  yellowCards: [number, number] = [0, 0]
  redCards: [number, number] = [0, 0]
  passesAttempted: [number, number] = [0, 0]
  passesCompleted: [number, number] = [0, 0]
  xg: [number, number] = [0, 0] // toplam beklenen gol
  pendingXg = 0 // son şutun xG'si; şut sonucu olayına iliştirilir
  // Oyuncu değişikliği: kalan yedek havuzu, kullanılan hak, açılmış pencere,
  // ve kayıtlar (oynatmada zaman-farkındalıklı isim/numara için)
  benchPool: PlayerInfo[][] = [[], []]
  subsUsed: [number, number] = [0, 0]
  subWindowIdx: [number, number] = [0, 0]
  substitutions: SubRecord[] = []
  // Takım taktiği (mentalite/pres/genişlik); yoksa dengeli
  tactics: [TeamTactics, TeamTactics] = [BALANCED_TACTICS, BALANCED_TACTICS]
  // Skor/zaman farkındalıklı EFEKTİF taktik: geç maçta önde olan geri çekilir,
  // geride olan öne yüklenir. Her tick güncellenir; motor bunu okur.
  effTactics: [TeamTactics, TeamTactics] = [BALANCED_TACTICS, BALANCED_TACTICS]

  constructor(home: TeamInfo, away: TeamInfo, seed: number, knockout = false) {
    this.rng = createRng(seed)
    this.knockout = knockout
    this.maxTicks = knockout ? KO_MAX_TICKS : REG_MAX_TICKS
    this.frames = new Float32Array(this.maxTicks * FRAME_STRIDE)
    // Takımları klonla: starters/subs dizileri maç içinde referansla değişebilir;
    // modül sabitlerine (KIZILKAYA/MAVIDERE) sızmamalı. starters DEĞİŞMEZ kalır
    // (ilk onbir); değişiklikler player.info + substitutions kaydında tutulur.
    const clone = (tm: TeamInfo): TeamInfo => ({
      ...tm,
      starters: [...tm.starters],
      subs: [...tm.subs],
    })
    this.teams = [clone(home), clone(away)]
    this.tactics = [home.tactics ?? BALANCED_TACTICS, away.tactics ?? BALANCED_TACTICS]
    this.effTactics = [this.tactics[0], this.tactics[1]]
    this.benchPool = [[...this.teams[0].subs], [...this.teams[1].subs]]
    for (let t = 0; t < 2; t++) {
      const info = this.teams[t]
      info.starters.forEach((p, i) => {
        this.players.push({
          id: t * 11 + i,
          info: p,
          teamIdx: t,
          slotIdx: i,
          job: FORMATIONS[info.formation][i].job,
          pos: vec(0, 0),
          vel: vec(0, 0),
          energy: 1,
          sprintReserve: 1,
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

  // --- alt sistem delegeleri ---
  // Modüller arası tüm çapraz çağrılar bu ince katmandan geçer; gövdeler
  // restarts/discipline/onball/offball/shootout modüllerinde yaşar.

  setupRestart(kind: RestartKind, forTeam: number, spot: Vec2, timer: number): void {
    restarts.setupRestart(this, kind, forTeam, spot, timer)
  }

  computeRestartTargets(): void {
    restarts.computeRestartTargets(this)
  }

  snapToRestartTargets(): void {
    restarts.snapToRestartTargets(this)
  }

  stepRestart(dt: number): void {
    restarts.stepRestart(this, dt)
  }

  startCelebration(team: number, scorerId: number): void {
    restarts.startCelebration(this, team, scorerId)
  }

  freeKickType(spot: Vec2, forTeam: number): 'shoot' | 'cross' | 'short' {
    return restarts.freeKickType(this, spot, forTeam)
  }

  trySubstitutions(): void {
    discipline.trySubstitutions(this)
  }

  handleFoul(tacklerId: number, victimId: number): void {
    discipline.handleFoul(this, tacklerId, victimId)
  }

  handleHandball(offender: PlayerSim): void {
    discipline.handleHandball(this, offender)
  }

  rollFoulCard(tackler: PlayerSim): boolean {
    return discipline.rollFoulCard(this, tackler)
  }

  launchPass(byId: number, targetId: number, flight: 'pass' | 'cross' = 'pass', exemptOffside = false): void {
    onball.launchPass(this, byId, targetId, flight, exemptOffside)
  }

  launchShot(byId: number, quality: number, isPenalty = false, headed = false): void {
    onball.launchShot(this, byId, quality, isPenalty, headed)
  }

  launchClearance(byId: number): void {
    onball.launchClearance(this, byId)
  }

  stepRolling(dt: number): void {
    onball.stepRolling(this, dt)
  }

  stepInFlight(dt: number): void {
    onball.stepInFlight(this, dt)
  }

  movePlayers(dt: number): void {
    offball.movePlayers(this, dt)
  }

  startShootout(): void {
    shootoutMod.startShootout(this)
  }

  resolveShootoutKick(takerId: number, scored: boolean): void {
    shootoutMod.resolveShootoutKick(this, takerId, scored)
  }

  freezeShootoutBystanders(): void {
    shootoutMod.freezeShootoutBystanders(this)
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
    if (b.flight !== 'shot' && b.bPos) return b.bPos // balistik uçuş: gerçek konum
    return this.flightPos(b)
  }

  // Şut uçuş konumu (parametrik): kale düzlemindeki kesişmeye sabit tempoda
  // gider; falso iki uçta sıfıra dönen yanal bombedir (kesişme noktası değişmez)
  flightPos(b: Extract<BallState, { kind: 'inFlight' }>): Vec2 {
    const tt = Math.min(1, b.t)
    const pos = lerp(b.from, b.to, tt)
    if (b.flight === 'shot' && b.curl) {
      pos.y += b.curl * Math.sin(Math.PI * tt)
    }
    return pos
  }

  // Balistik hava topu kur (pas/orta/degaj): iniş noktası `to`ya T sürede
  // varacak ilk hız + yerçekimi; falso yanal ivme olarak uygulanır ama
  // ön-telafilidir (v0 = 4A/T, a = -8A/T² → varışta net sapma 0, tepe A).
  aerialBall(
    from: Vec2,
    to: Vec2,
    duration: number,
    flight: 'pass' | 'clearance' | 'cross',
    byId: number,
    targetId: number | null,
    offside = false,
    curlAmp = 0,
    hMax?: number,
  ): void {
    const T = Math.max(0.2, duration)
    const dirX = (to.x - from.x) / T
    const dirY = (to.y - from.y) / T
    const z0 = 0.25
    const vz0 = (0.5 * 9.81 * T * T - z0) / T
    let curlAx: Vec2 | undefined
    let curlA: number | undefined
    let vx = dirX
    let vy = dirY
    if (curlAmp) {
      const L = Math.hypot(to.x - from.x, to.y - from.y)
      if (L > 1e-6) {
        curlAx = { x: -(to.y - from.y) / L, y: (to.x - from.x) / L }
        const v0c = (4 * curlAmp) / T
        curlA = (-8 * curlAmp) / (T * T)
        vx += curlAx.x * v0c
        vy += curlAx.y * v0c
      }
    }
    this.ball = {
      kind: 'inFlight',
      from: { ...from },
      to: { ...to },
      t: 0,
      duration: T,
      flight,
      byId,
      targetId,
      offside,
      hMax: hMax ?? z0 + (vz0 * vz0) / (2 * 9.81),
      curl: curlAmp,
      bPos: { ...from },
      bVel: { x: vx, y: vy },
      bZ: z0,
      bVz: vz0,
      curlAx,
      curlA,
      bounces: 0,
    }
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
    if (this.half === 1) return this.halfClock
    if (this.half === 2) return HALF_SECONDS + this.halfClock
    if (this.half === 3) return 2 * HALF_SECONDS + this.halfClock // uzatma 1 (90'+)
    return 2 * HALF_SECONDS + ET_SECONDS + this.halfClock // uzatma 2 (105'+)
  }

  toAttack(p: Vec2, teamIdx: number): Vec2 {
    const d = this.attackDir[teamIdx]
    return { x: p.x * d, y: p.y * d }
  }

  fromAttack(p: Vec2, teamIdx: number): Vec2 {
    const d = this.attackDir[teamIdx]
    return { x: p.x * d, y: p.y * d }
  }

  pushEvent(kind: MatchEventKind, teamIdx: number, playerId = -1, targetId = -1, text?: string): void {
    // Şut sonucu olaylarına o şutun xG'sini iliştir (tek kullanımlık)
    let xg: number | undefined
    if (
      this.pendingXg > 0 &&
      (kind === 'shot_saved' ||
        kind === 'shot_missed' ||
        kind === 'shot_blocked' ||
        kind === 'woodwork' ||
        kind === 'goal')
    ) {
      xg = this.pendingXg
      this.pendingXg = 0
    }
    this.events.push({
      tick: this.tick,
      clock: this.clockDisplay(),
      kind,
      teamIdx,
      playerId,
      targetId,
      scoreHome: this.score[0],
      scoreAway: this.score[1],
      text,
      xg,
    })
  }

  // Organik kondisyon güncellemesi (her tick, oyuncu başına). İki havuz:
  // aerobik (energy) yavaş erir/toparlanır ve maç-boyu tavana takılır; sprint
  // rezervi (sprintReserve) yüksek yoğunlukta hızlı boşalır, jog/dinlenmede
  // hızlı dolar (ama enerjiden çok yukarı çıkamaz — gassed oyuncu üst üste
  // koşamaz). moved: bu tick katedilen metre.
  updateStamina(p: PlayerSim, moved: number, dt: number): void {
    const stam = p.info.attributes.stamina
    const spdMax = Math.max(1, maxSpeed(p.info.attributes))
    const intensity = Math.min(1, moved / dt / spdMax) // 0 dururken .. 1 tam sprint
    const engine = enginePace(p.id)
    // Aerobik: yoğunluğa göre yak, düşük yoğunlukta topla (tavana kadar)
    const prog = Math.min(1, this.clockDisplay() / (90 * 60))
    const ceiling = energyCeiling(prog, stam)
    let e = p.energy - aerobicDrain(moved, stam, intensity, engine)
    e += aerobicRecover(stam, intensity, dt)
    if (e > ceiling) e = Math.max(ceiling, e - dt * 0.0025) // tavan üstü yavaşça iner
    p.energy = Math.max(0.15, Math.min(1, e))
    // Sprint rezervi: yalnız SÜRDÜRÜLEN yüksek yoğunlukta boşalır, ara verince
    // hızlı dolar — normal oyunda çoğunlukla dolu kalır, üst üste sprintte
    // düşer. Enerjiden ~0.2'den fazla yukarı çıkamaz (bitkin oyuncunun
    // patlayıcılığı da biter).
    let r = p.sprintReserve
    if (intensity > 0.82) {
      r -= dt * 0.38 * (1.5 - stam / 20) * engine
    } else {
      r += dt * (intensity < 0.4 ? 0.6 : 0.28) * (0.7 + stam / 40)
    }
    p.sprintReserve = Math.max(0, Math.min(Math.min(1, p.energy + 0.2), r))
  }

  // Skor/zaman farkındalığı: geç maçta (60'+) önde olan takım savunmaya çekilir
  // (mentalite/pres düşer), geride olan öne yüklenir (mentalite/pres artar).
  // Fark büyüdükçe ve süre azaldıkça etki güçlenir. Efektif taktik her tick
  // taban taktik + bu kaymayla hesaplanır; ±1.5 ile sınırlanır.
  updateEffectiveTactics(): void {
    const clock = this.clockDisplay()
    const timeFactor = Math.min(1, Math.max(0, (clock - 60 * 60) / (30 * 60))) // 60'..90'
    const clamp = (v: number): number => Math.max(-1.5, Math.min(1.5, v))
    for (let t = 0; t < 2; t++) {
      const base = this.tactics[t]
      const diff = this.score[t] - this.score[1 - t]
      let mShift = 0
      let pShift = 0
      if (diff > 0 && timeFactor > 0) {
        // Önde: avantajı koru — geri çekil, presi düşür
        const k = Math.min(1, diff * 0.6) * timeFactor
        mShift = -k
        pShift = -0.3 * timeFactor * Math.min(1, diff)
      } else if (diff < 0 && timeFactor > 0) {
        // Geride: maçı kovala — öne yüklen, presi artır
        const k = Math.min(1, -diff * 0.5) * timeFactor
        mShift = k * 1.1
        pShift = 0.5 * timeFactor * Math.min(1, -diff)
      }
      this.effTactics[t] =
        mShift === 0 && pShift === 0
          ? base
          : {
              mentality: clamp(base.mentality + mShift),
              press: clamp(base.press + pShift),
              width: base.width,
            }
    }
  }

  // Topun kontrolünü al: top fiziksel kalır (yerinden oynamaz), yalnız
  // kontrolcü değişir. `at` verilirse top oraya yerleştirilir (restart vb.)
  possess(playerId: number, at?: Vec2): void {
    const pos = at ?? (this.ball.kind === 'rolling' ? this.ball.pos : this.ballPos())
    this.ball = { kind: 'rolling', pos: { ...pos }, vel: vec(0, 0), controllerId: playerId }
    const p = this.players[playerId]

    // Pas niyeti çözümü: ilk kontrol anı
    const pi = this.passIntent
    if (pi) {
      this.passIntent = null
      if (p.teamIdx === pi.team) {
        if (pi.offside) {
          // Ofsayt düdüğü topa dokunma anında (gerçek kural)
          this.offsides[pi.team]++
          this.pushEvent('offside', pi.team, playerId)
          const spot = {
            x: Math.max(-HALF_LENGTH + 2, Math.min(HALF_LENGTH - 2, pos.x)),
            y: Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, pos.y)),
          }
          this.setupRestart('free_kick', 1 - pi.team, spot, 55)
          return
        }
        this.passesCompleted[pi.team]++
      } else if (playerId !== pi.byId) {
        this.pushEvent('interception', p.teamIdx, playerId)
      }
    }
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
    this.nextDecisionTick = this.tick + 14
    // Kaleci topu alınca: takım build-up şekline açılana kadar (baskı yoksa)
    // topu tutabileceği tavan — ~2.8 sn (12 tick karar penceresi + 28 tick hold)
    if (p.info.role === 'GK') this.gkHoldUntil = this.tick + 40
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
      const gkAtt = this.toAttack(spot, p.teamIdx)
      const inBox =
        gkAtt.x < -HALF_LENGTH + PENALTY_AREA_DEPTH && Math.abs(gkAtt.y) < PENALTY_AREA_WIDTH / 2
      if (inBox) {
        this.possess(playerId, spot) // ceza sahasında: elle alır
      } else {
        // Ceza sahası dışında (sweeper): elle alamaz — ayakla uzağa temizler
        this.possess(playerId, spot)
        this.launchClearance(playerId)
      }
      return
    }
    const ctl = controlSkill(p.info.attributes)
    // Kolay top (yavaş, yerden, baskısız) neredeyse her zaman temiz alınır;
    // zorluk arttıkça kontrol becerisi belirleyici olur
    // Yorgun ayak ilk dokunuşu bozar (yumuşak: 0.7 üstünde etkisiz, altında
    // hafif — atağı boğmasın diye tam sharpness değil, yarısı uygulanır)
    const cleanP =
      Math.max(0.4, Math.min(0.985, 0.985 - difficulty * 0.65 + (ctl - 0.65) * 0.45)) *
      (0.5 + 0.5 * sharpness(p.energy))
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
    // İVME TAVANI: hız değişimi insan ivmesiyle sınırlıdır (~13 m/s²).
    // k-karışımı tek başına tam geri dönüşü tek tick'te yapabiliyordu
    // (Δv≈10 m/s) — mücadelede mekik/takılma görüntüsünün fizik kaynağı.
    // Tavanla dönüş doğal olur: önce fren, sonra yeni yöne hızlanma.
    let dvx = (desired.x - p.vel.x) * k
    let dvy = (desired.y - p.vel.y) * k
    const dvMag = Math.hypot(dvx, dvy)
    // 45 m/s²: en sert yön dönüşlerini sınırlar (ters dönme 3.4x azalır) ama
    // pasa yetişmeyi engellemez — 13'te alıcı topa yetişemiyor, araya girme patlıyor
    const maxDv = 45 * dt
    if (dvMag > maxDv) {
      dvx *= maxDv / dvMag
      dvy *= maxDv / dvMag
    }
    p.vel = { x: p.vel.x + dvx, y: p.vel.y + dvy }
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
          // Çalımda az önce ekarte olmuş (tackleCooldown'da) rakip, topu
          // taşıyanın önünde fiziksel duvar olmaya devam etmesin — "adamı
          // geçti" anı görünür olsun. Yoksa duel kazanılır ama rakibin
          // yerinden kımıldamamış bedenine hemen bir sonraki dokunuşta
          // tekrar çarpılır (gidiyor duruyor kekemeliği).
          if ((a.tackleCooldown > 0 && b.id === cid) || (b.tackleCooldown > 0 && a.id === cid)) {
            continue
          }
          const overlap = MIN - d
          if (aDown && bDown) continue
          if (aDown) {
            b.pos.x += ux * overlap
            b.pos.y += uy * overlap
            this.killClosingVel(b, -ux, -uy)
          } else if (bDown) {
            a.pos.x -= ux * overlap
            a.pos.y -= uy * overlap
            this.killClosingVel(a, ux, uy)
          } else {
            a.pos.x -= ux * (overlap / 2)
            a.pos.y -= uy * (overlap / 2)
            b.pos.x += ux * (overlap / 2)
            b.pos.y += uy * (overlap / 2)
            this.killClosingVel(a, ux, uy)
            this.killClosingVel(b, -ux, -uy)
          }
          // Konumla birlikte YAKLAŞMA HIZI da söner (esnemesiz temas):
          // içeri koşan bileşen kalkar, teğet bileşen kalır — gövdeler
          // birbirinin etrafından kayar. Bu olmadan movePlayer her tick
          // hızı içeri kurar, taban dışarı iter: mücadelede titreme olur.
          const vn = (b.vel.x - a.vel.x) * ux + (b.vel.y - a.vel.y) * uy
          if (vn < 0) {
            if (aDown) {
              b.vel.x -= ux * vn
              b.vel.y -= uy * vn
            } else if (bDown) {
              a.vel.x += ux * vn
              a.vel.y += uy * vn
            } else {
              a.vel.x += ux * (vn / 2)
              a.vel.y += uy * (vn / 2)
              b.vel.x -= ux * (vn / 2)
              b.vel.y -= uy * (vn / 2)
            }
          }
        }
      }
    }
  }

  // Çarpışma normali yönündeki "içe" hız bileşenini söndürür: pozisyon
  // düzeltmesi hızı değiştirmezse oyuncu bir sonraki tick'te aynı yöne
  // tekrar itilmiş olur ve düzeltme her tick tekrarlanır (tık tık
  // kekemelik). Teğetsel (yanal) hız korunur — ikili mücadelede oyuncular
  // hâlâ birbirinin etrafında akışkan şekilde kayabilir.
  private killClosingVel(p: PlayerSim, towardNx: number, towardNy: number): void {
    const closing = p.vel.x * towardNx + p.vel.y * towardNy
    if (closing > 0) {
      p.vel.x -= closing * towardNx
      p.vel.y -= closing * towardNy
    }
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

  addStoppage(sec: number): void {
    this.stoppage = Math.min(300, this.stoppage + sec)
  }

  // --- tick ---

  step(): void {
    if (this.finished) return
    const dt = TICK_DT

    // Devre sonu kontrolü (güvenli anda; penaltı serisinde atlanır)
    const periodLen = (this.half <= 2 ? HALF_SECONDS : ET_SECONDS) + this.stoppage
    if (
      !this.soActive &&
      this.halfClock >= periodLen &&
      this.phase.kind === 'open' &&
      this.ball.kind !== 'inFlight'
    ) {
      this.endOfPeriod()
      if (this.finished) {
        this.recordFrame()
        return
      }
    }

    this.updateEffectiveTactics()

    if (this.phase.kind === 'restart') {
      this.stepRestart(dt)
    } else {
      this.stepOpen(dt)
    }
    // Penaltı serisinde bekleyenler yerinde dursun (kaotik koşuşturma olmasın)
    if (this.soActive) this.freezeShootoutBystanders()

    this.refPos = moveReferee(this.refPos, this.ballPos(), dt)
    for (const p of this.players) {
      if (p.tackleCooldown > 0) p.tackleCooldown = Math.max(0, p.tackleCooldown - dt)
    }

    const poss = this.possTeam()
    if (poss === 0) this.possTicks[0]++
    else if (poss === 1) this.possTicks[1]++

    this.recordFrame()
    if (!this.soActive) this.halfClock += dt // seri sırasında saat donar
    this.tick++
  }

  // Devre sonu geçişleri: normal maçta 2 devre; elemeli beraberlikte uzatma
  // (2×15) ve gerekirse penaltı serisi.
  endOfPeriod(): void {
    const draw = this.score[0] === this.score[1]
    if (this.half === 1) {
      this.pushEvent('half_end', -1)
      this.half = 2
      this.halfClock = 0
      this.stoppage = 45 + this.rng.int(0, 105)
      this.attackDir = [-1, 1]
      this.setupRestart('kickoff', 1, vec(0, 0), 30)
      this.snapToRestartTargets()
    } else if (this.half === 2) {
      if (this.knockout && draw) {
        this.pushEvent('extra_time', -1, -1, -1, 'Skorda eşitlik — uzatma devrelerine gidiliyor')
        this.half = 3
        this.halfClock = 0
        this.stoppage = 15 + this.rng.int(0, 45)
        this.attackDir = [1, -1]
        this.setupRestart('kickoff', 0, vec(0, 0), 30)
        this.snapToRestartTargets()
      } else {
        this.pushEvent('full_time', -1)
        this.finished = true
      }
    } else if (this.half === 3) {
      this.pushEvent('half_end', -1)
      this.half = 4
      this.halfClock = 0
      this.stoppage = 15 + this.rng.int(0, 45)
      this.attackDir = [-1, 1]
      this.setupRestart('kickoff', 1, vec(0, 0), 30)
      this.snapToRestartTargets()
    } else if (draw) {
      this.startShootout()
    } else {
      this.pushEvent('full_time', -1)
      this.finished = true
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

  ballHeight(): number {
    if (this.ball.kind !== 'inFlight') return 0
    const t = Math.min(1, this.ball.t)
    // Şut: ayaktan çıkıp kale düzlemindeki gerçek kesişme yüksekliğine gider —
    // üstten aut ve üst köşe şutları görselde de yükselir
    if (this.ball.flight === 'shot' && this.ball.zTo !== undefined) {
      return 0.25 + (this.ball.zTo - 0.25) * t
    }
    // Balistik uçuş: gerçek yükseklik (sekmeler görselde de görünür)
    return this.ball.bZ ?? 4 * (this.ball.hMax ?? 0) * t * (1 - t)
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
      f[o + F_ENERGY + i] = this.players[i].energy
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
      xg: [this.xg[0], this.xg[1]],
    }
  }
}

export function simulateMatch(
  home: TeamInfo,
  away: TeamInfo,
  seed: number,
  knockout = false,
): MatchResult {
  const sim = new MatchSim(home, away, seed, knockout)
  while (!sim.finished && sim.tick < sim.maxTicks - 1) {
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
    teams: sim.teams, // ilk onbir (klon; starters değişmez)
    substitutions: sim.substitutions,
    shootout:
      sim.soWinner >= 0
        ? { score: [sim.soScore[0], sim.soScore[1]], winner: sim.soWinner, kicks: sim.soResults }
        : undefined,
  }
}
