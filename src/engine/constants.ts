// Saha ölçüleri (metre). Orijin saha merkezi, x uzun eksen, y kısa eksen.
export const PITCH_LENGTH = 105
export const PITCH_WIDTH = 68
export const HALF_LENGTH = PITCH_LENGTH / 2
export const HALF_WIDTH = PITCH_WIDTH / 2

export const GOAL_WIDTH = 7.32
export const HALF_GOAL = GOAL_WIDTH / 2
export const GOAL_DEPTH = 2.4

export const PENALTY_AREA_DEPTH = 16.5
export const PENALTY_AREA_WIDTH = 40.32
export const SIX_YARD_DEPTH = 5.5
export const SIX_YARD_WIDTH = 18.32
export const PENALTY_SPOT_DIST = 11
export const CENTER_CIRCLE_R = 9.15
export const CORNER_ARC_R = 1

// Simülasyon zamanı
export const TICK_DT = 0.1 // saniye / tick
export const TICKS_PER_SEC = 10
export const HALF_SECONDS = 45 * 60

// Frame kaydı düzeni (Float32Array stride)
// [clockSec, labelIdx, possTeam, ballX, ballY, refX, refY, possHomeTicks, possAwayTicks, 22 × (x, y)]
export const FRAME_STRIDE = 9 + 22 * 2

export const F_CLOCK = 0
export const F_LABEL = 1
export const F_POSS_TEAM = 2
export const F_BALL_X = 3
export const F_BALL_Y = 4
export const F_REF_X = 5
export const F_REF_Y = 6
export const F_POSS_HOME = 7
export const F_POSS_AWAY = 8
export const F_PLAYERS = 9
