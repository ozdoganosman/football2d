import { HALF_LENGTH, PENALTY_SPOT_DIST } from './constants'
import { composureFactor, shootSkill } from './attributes'
import { vec } from './vec'
import type { MatchSim } from './engine'

// Penaltı serisi (elemeli maçta 120' beraberliğinde): vurucu sırası,
// vuruş kurulumu, seyircilerin sabitlenmesi ve seri sonucunun çözümü.

export function startShootout(sim: MatchSim): void {
  sim.soActive = true
  sim.soScore = [0, 0]
  sim.soKicks = [0, 0]
  sim.soResults = []
  // Vurucu sırası: saha oyuncuları, bitiricilik×soğukkanlılık en iyi önce
  for (let t = 0; t < 2; t++) {
    sim.soOrder[t] = sim
      .active(t)
      .filter((p) => p.info.role !== 'GK')
      .sort(
        (a, b) =>
          shootSkill(b.info.attributes) * composureFactor(b.info.attributes) -
          shootSkill(a.info.attributes) * composureFactor(a.info.attributes),
      )
      .map((p) => p.id)
  }
  sim.soTeamTurn = sim.rng.chance(0.5) ? 0 : 1 // yazı-tura
  sim.pushEvent('shootout', -1, -1, -1, 'Penaltı atışlarına geçiliyor')
  setupShootoutKick(sim)
}

export function setupShootoutKick(sim: MatchSim): void {
  const team = sim.soTeamTurn
  const order = sim.soOrder[team]
  const takerId = order[sim.soKicks[team] % order.length]
  // Vuran takım daima +x kaleye vurur (seri tek kalede oynanır)
  sim.attackDir = team === 0 ? [1, -1] : [-1, 1]
  const spot = sim.fromAttack({ x: HALF_LENGTH - PENALTY_SPOT_DIST, y: 0 }, team)
  sim.engagerId = [-1, -1]
  sim.passIntent = null
  sim.pendingShot = null
  sim.keeperDive = null
  sim.celebrateUntil = -1
  sim.phase = {
    kind: 'restart',
    restart: 'penalty',
    forTeam: team,
    spot: { ...spot },
    timer: 40,
    takerId,
  }
  sim.lastTouchTeam = team
  sim.lastTouchId = takerId
  sim.computeRestartTargets()
  sim.snapToRestartTargets()
  // Vuran ve savunan kaleci dışında herkes orta yuvarlağa dizilir (gerçek
  // seri görünümü) ve orada sabitlenir (freeze). Vuran takım bir yanda,
  // savunan takım öbür yanda.
  const defGk = sim.keeperOf(1 - team)
  const keep = new Set<number>([takerId, defGk?.id ?? -1])
  const waiting = sim.players.filter((p) => !p.sentOff && !keep.has(p.id))
  let ki = 0
  let di = 0
  for (const p of waiting) {
    const kicking = p.teamIdx === team
    const i = kicking ? ki++ : di++
    p.pos = {
      x: -12 + (i % 6) * 4.8,
      y: (kicking ? -1 : 1) * (12 + Math.floor(i / 6) * 3),
    }
    p.vel = vec(0, 0)
  }
  sim.soPin = waiting.map((p) => ({ id: p.id, pos: { ...p.pos } }))
}

export function freezeShootoutBystanders(sim: MatchSim): void {
  for (const { id, pos } of sim.soPin) {
    const p = sim.players[id]
    p.pos = { x: pos.x, y: pos.y }
    p.vel = vec(0, 0)
  }
}

export function resolveShootoutKick(sim: MatchSim, takerId: number, scored: boolean): void {
  const team = sim.players[takerId].teamIdx
  sim.soResults.push({ team, takerId, scored })
  if (scored) sim.soScore[team]++
  sim.soKicks[team]++
  const label = sim.teams[team].shortName
  const name = sim.players[takerId].info.name
  sim.pushEvent(
    'shootout',
    team,
    takerId,
    -1,
    `${scored ? 'GOL' : 'KAÇTI'} — ${name} (${label}) · seri ${sim.soScore[0]}-${sim.soScore[1]}`,
  )
  const winner = decideShootout(sim)
  if (winner >= 0) {
    sim.soWinner = winner
    sim.soActive = false
    sim.ball = { kind: 'rolling', pos: vec(0, 0), vel: vec(0, 0), controllerId: -1 }
    sim.phase = { kind: 'open' }
    sim.pushEvent(
      'full_time',
      -1,
      -1,
      -1,
      `Penaltılarda ${sim.teams[winner].name} kazandı (${sim.soScore[0]}-${sim.soScore[1]})`,
    )
    sim.finished = true
    return
  }
  sim.soTeamTurn = 1 - team
  setupShootoutKick(sim)
}

// Kazanan takım (-1 belirsiz): ilk 5'te yenilmez üstünlük ya da ani ölümde fark
export function decideShootout(sim: MatchSim): number {
  const [a, b] = sim.soScore
  const [ka, kb] = sim.soKicks
  const remA = Math.max(0, 5 - ka)
  const remB = Math.max(0, 5 - kb)
  if (a > b + remB) return 0
  if (b > a + remA) return 1
  if (ka >= 5 && kb >= 5 && ka === kb && a !== b) return a > b ? 0 : 1
  return -1
}
