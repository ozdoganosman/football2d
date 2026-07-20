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
}

export interface PlayerInfo {
  name: string
  number: number
  role: Role
  attributes: PlayerAttributes
}

export type FormationId = '4-4-2' | '4-3-3' | '4-2-3-1' | '3-5-2'

export interface TeamInfo {
  name: string
  shortName: string
  color: string
  gkColor: string
  formation: FormationId
  starters: PlayerInfo[] // 11 oyuncu, [0] kaleci
  subs: PlayerInfo[]
}

// Formasyon slotu: depth 0 = kendi kale çizgisi, 1 = rakip kale çizgisi; width -1..1
export interface FormationSlot {
  depth: number
  width: number
  role: Role
}

export type BallState =
  | { kind: 'loose'; pos: Vec2; vel: Vec2 }
  | { kind: 'possessed'; playerId: number }
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
  energy: number // 0..1
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
  | 'yellow_card'
  | 'red_card'
  | 'shot_saved'
  | 'shot_missed'
  | 'shot_blocked'
  | 'goal'
  | 'penalty_awarded'
  | 'corner'
  | 'throw_in'
  | 'goal_kick'
  | 'free_kick'
  | 'offside'
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
  teams: [TeamInfo, TeamInfo]
}
