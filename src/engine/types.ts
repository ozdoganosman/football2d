export interface Vec2 {
  x: number
  y: number
}

export type Role = 'GK' | 'DF' | 'MF' | 'FW'

// FM tarzı 1–20 aralığında nitelikler
export interface PlayerAttributes {
  pace: number
  passing: number
  shooting: number
  dribbling: number
  tackling: number
  positioning: number
  goalkeeping: number
  stamina: number
  height: number // boy: hava topunda baskın
  strength: number // güç: hava mücadelesi, topu koruma, fiziksel müdahale
  heading: number // kafa: kafa vuruşunu yönlendirme/bitirme
  composure: number // soğukkanlılık: baskı altında bitiricilik ve penaltı
}

export interface PlayerInfo {
  name: string
  number: number
  role: Role
  attributes: PlayerAttributes
}

export type FormationId = '4-4-2' | '4-3-3' | '4-2-3-1' | '3-5-2'

// Takım taktiği: her eksen -1 / 0 / +1. 0 = dengeli (mevcut varsayılan davranış).
export interface TeamTactics {
  mentality: number // -1 defansif, 0 dengeli, +1 hücumcu (blok yüksekliği + risk)
  press: number // -1 alçak blok, 0 orta, +1 yüksek pres (karşılama hattı)
  width: number // -1 dar, 0 normal, +1 geniş (blok genişliği)
}

export const BALANCED_TACTICS: TeamTactics = { mentality: 0, press: 0, width: 0 }

export interface TeamInfo {
  name: string
  shortName: string
  color: string
  gkColor: string
  formation: FormationId
  starters: PlayerInfo[] // 11 oyuncu, [0] kaleci
  subs: PlayerInfo[]
  tactics?: TeamTactics // yoksa dengeli
}

// Formasyon slotu: depth 0 = kendi kale çizgisi, 1 = rakip kale çizgisi; width -1..1
export interface FormationSlot {
  depth: number
  width: number
  role: Role
}

export type BallState =
  // Yerdeki top HER ZAMAN fizikseldir: konum + hız + sürtünme.
  // controllerId topu "kullanan" oyuncudur (-1 = boşta); top sürme, topa
  // gerçek vuruşlar yapıp kovalamaktır — top oyuncuya bağlı değildir.
  | { kind: 'rolling'; pos: Vec2; vel: Vec2; controllerId: number; curl?: number }
  | {
      kind: 'inFlight'
      from: Vec2
      to: Vec2
      t: number // 0..1 ilerleme
      duration: number // saniye
      flight: 'pass' | 'shot' | 'clearance' | 'cross'
      byId: number
      targetId: number | null
      shotQuality?: number
      offside?: boolean // pas anında alıcı ofsayttaydı; varışta düdük çalınır
      hMax?: number // uçuş tepe yüksekliği (m); 0/undefined = yerden pas
      curl?: number // yalnız şutlarda: yanal falso genliği (m), iki uçta da sıfır
    }

export type RestartKind =
  | 'kickoff'
  | 'throw_in'
  | 'corner'
  | 'goal_kick'
  | 'free_kick'
  | 'penalty'

export type Phase =
  | { kind: 'open' }
  | {
      kind: 'restart'
      restart: RestartKind
      forTeam: number
      spot: Vec2
      timer: number // tick sayacı
      takerId: number
    }

export interface PlayerSim {
  id: number // 0..10 ev sahibi, 11..21 deplasman
  info: PlayerInfo
  teamIdx: number // 0 ev sahibi, 1 deplasman
  slotIdx: number
  pos: Vec2
  vel: Vec2 // atalet: ani yön değişimleri yumuşatılır
  energy: number // 0..1 aerobik kondisyon (maç-boyu yavaş erir)
  sprintReserve: number // 0..1 anaerobik patlayıcılık (hızlı boşalır/dolar)
  tackleCooldown: number // saniye
  sentOff: boolean
  yellows: number
  dribbleDir: Vec2 | null // topu taşırken seçilen yön
}

export type MatchEventKind =
  | 'kickoff'
  | 'pass'
  | 'interception'
  | 'tackle'
  | 'foul'
  | 'advantage'
  | 'yellow_card'
  | 'red_card'
  | 'shot_saved'
  | 'shot_missed'
  | 'shot_blocked'
  | 'woodwork'
  | 'header'
  | 'goal'
  | 'own_goal'
  | 'penalty_awarded'
  | 'corner'
  | 'throw_in'
  | 'goal_kick'
  | 'free_kick'
  | 'offside'
  | 'miscontrol'
  | 'substitution'
  | 'injury'
  | 'half_end'
  | 'full_time'

export interface MatchEvent {
  tick: number
  clock: number // gösterilen saat (saniye)
  kind: MatchEventKind
  teamIdx: number
  playerId: number // -1 = yok
  targetId: number // -1 = yok
  scoreHome: number
  scoreAway: number
  text?: string // hazır yorum/feed metni (örn. oyuncu değişikliği); varsa şablona üstün gelir
}

// Oyuncu değişikliği kaydı: kare-slot eşlemesi zamandan bağımsız olduğundan,
// oynatma sırasında hangi anda kimin sahada olduğunu bu kayıtlar belirler.
export interface SubRecord {
  tick: number
  teamIdx: number
  slotIdx: number
  inInfo: PlayerInfo
}

export interface MatchStats {
  possession: [number, number] // yüzde
  shots: [number, number]
  shotsOnTarget: [number, number]
  goals: [number, number]
  corners: [number, number]
  fouls: [number, number]
  yellowCards: [number, number]
  redCards: [number, number]
  offsides: [number, number]
  passes: [number, number]
  passesCompleted: [number, number]
}

export interface HighlightWindow {
  startTick: number
  endTick: number
}

export interface MatchResult {
  frames: Float32Array // FRAME_STRIDE × tick sayısı
  frameCount: number
  events: MatchEvent[]
  stats: MatchStats
  highlights: HighlightWindow[]
  seed: number
  teams: [TeamInfo, TeamInfo] // İLK ONBİR (starters değişmez); değişiklikler substitutions'ta
  substitutions: SubRecord[]
}
