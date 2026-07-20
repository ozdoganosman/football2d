// Headless denge aracı: N maç simüle eder, gol/istatistik raporu basar.
// Kullanım: npm run sim -- --matches 200 --seed 1
import { simulateMatch } from '../engine/engine'
import { KIZILKAYA, MAVIDERE } from '../data/teams'

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1])
  return def
}

const matches = arg('matches', 20)
const baseSeed = arg('seed', 1)

let homeWins = 0
let draws = 0
let awayWins = 0
let totalGoals = 0
const goalDist = new Map<number, number>()
const sums = {
  shots: [0, 0],
  onTarget: [0, 0],
  possession: [0, 0],
  corners: [0, 0],
  fouls: [0, 0],
  yellows: [0, 0],
  reds: [0, 0],
  offsides: [0, 0],
  passes: [0, 0],
  passAcc: [0, 0],
}

const t0 = Date.now()
for (let m = 0; m < matches; m++) {
  const r = simulateMatch(KIZILKAYA, MAVIDERE, baseSeed + m)
  const [gh, ga] = r.stats.goals
  if (gh > ga) homeWins++
  else if (gh < ga) awayWins++
  else draws++
  totalGoals += gh + ga
  goalDist.set(gh + ga, (goalDist.get(gh + ga) ?? 0) + 1)
  for (const t of [0, 1] as const) {
    sums.shots[t] += r.stats.shots[t]
    sums.onTarget[t] += r.stats.shotsOnTarget[t]
    sums.possession[t] += r.stats.possession[t]
    sums.corners[t] += r.stats.corners[t]
    sums.fouls[t] += r.stats.fouls[t]
    sums.yellows[t] += r.stats.yellowCards[t]
    sums.reds[t] += r.stats.redCards[t]
    sums.offsides[t] += r.stats.offsides[t]
    sums.passes[t] += r.stats.passes[t]
    sums.passAcc[t] += r.stats.passes[t] > 0 ? r.stats.passesCompleted[t] / r.stats.passes[t] : 0
  }
}
const elapsed = (Date.now() - t0) / 1000

const avg = (v: number): string => (v / matches).toFixed(2)

console.log(`\n${matches} maç simüle edildi (${elapsed.toFixed(1)} sn, seed ${baseSeed}..${baseSeed + matches - 1})`)
console.log(`${KIZILKAYA.name} (ev) vs ${MAVIDERE.name} (dep)\n`)
console.log(`Galibiyet/Beraberlik/Mağlubiyet (ev): ${homeWins}/${draws}/${awayWins}`)
console.log(`Maç başına gol ortalaması: ${(totalGoals / matches).toFixed(2)}\n`)
console.log('               Ev     Dep')
console.log(`Şut          ${avg(sums.shots[0]).padStart(6)}  ${avg(sums.shots[1]).padStart(6)}`)
console.log(`İsabet       ${avg(sums.onTarget[0]).padStart(6)}  ${avg(sums.onTarget[1]).padStart(6)}`)
console.log(`Topla oyn. % ${avg(sums.possession[0]).padStart(6)}  ${avg(sums.possession[1]).padStart(6)}`)
console.log(`Korner       ${avg(sums.corners[0]).padStart(6)}  ${avg(sums.corners[1]).padStart(6)}`)
console.log(`Faul         ${avg(sums.fouls[0]).padStart(6)}  ${avg(sums.fouls[1]).padStart(6)}`)
console.log(`Sarı kart    ${avg(sums.yellows[0]).padStart(6)}  ${avg(sums.yellows[1]).padStart(6)}`)
console.log(`Kırmızı      ${avg(sums.reds[0]).padStart(6)}  ${avg(sums.reds[1]).padStart(6)}`)
console.log(`Ofsayt       ${avg(sums.offsides[0]).padStart(6)}  ${avg(sums.offsides[1]).padStart(6)}`)
console.log(`Pas          ${avg(sums.passes[0]).padStart(6)}  ${avg(sums.passes[1]).padStart(6)}`)
console.log(
  `Pas isabeti %${((sums.passAcc[0] / matches) * 100).toFixed(0).padStart(5)}  %${((sums.passAcc[1] / matches) * 100).toFixed(0).padStart(4)}`,
)

console.log('\nToplam gol dağılımı:')
const keys = [...goalDist.keys()].sort((a, b) => a - b)
for (const k of keys) {
  const n = goalDist.get(k) ?? 0
  console.log(`${String(k).padStart(3)} gol: ${'#'.repeat(Math.ceil((n / matches) * 60))} (${n})`)
}
