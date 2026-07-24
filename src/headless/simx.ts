// Genişletilmiş denge aracı: standart istatistiklerin yanı sıra uzun taç ve
// sakatlık sıklığını da sayar. Kullanım: npm run simx -- --matches 200 --seed 1
import { simulateMatch } from '../engine/engine'
import { KIZILKAYA, MAVIDERE } from '../data/teams'

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1])
  return def
}

const matches = arg('matches', 20)
const baseSeed = arg('seed', 1)

let totalGoals = 0
let longThrows = 0
let handballs = 0
let headers = 0
let throwIns = 0
let intercepts = 0
let injuries = 0
let injSubs = 0
let manDown = 0
const sums = { shots: [0, 0], onTarget: [0, 0], corners: [0, 0], passAcc: [0, 0], xg: [0, 0] }

const t0 = Date.now()
for (let m = 0; m < matches; m++) {
  const r = simulateMatch(KIZILKAYA, MAVIDERE, baseSeed + m)
  totalGoals += r.stats.goals[0] + r.stats.goals[1]
  for (const t of [0, 1] as const) {
    sums.shots[t] += r.stats.shots[t]
    sums.onTarget[t] += r.stats.shotsOnTarget[t]
    sums.corners[t] += r.stats.corners[t]
    sums.xg[t] += r.stats.xg[t]
    sums.passAcc[t] += r.stats.passes[t] > 0 ? r.stats.passesCompleted[t] / r.stats.passes[t] : 0
  }
  for (const e of r.events) {
    if (e.kind === 'throw_in' && e.text && e.text.includes('Uzun taç')) longThrows++
    if (e.text && e.text.includes('El!')) handballs++
    if (e.kind === 'header') headers++
    if (e.kind === 'throw_in') throwIns++
    if (e.kind === 'interception') intercepts++
    if (e.kind === 'injury') {
      if (e.text && e.text.includes('eksik')) manDown++
      else injuries++
    }
    if (e.kind === 'substitution' && e.text && e.text.includes('Sakatlık')) injSubs++
  }
}
const elapsed = (Date.now() - t0) / 1000
const avg = (v: number): string => (v / matches).toFixed(2)

console.log(`\n${matches} maç (${elapsed.toFixed(1)} sn, seed ${baseSeed}..${baseSeed + matches - 1})`)
console.log(`Gol/maç: ${(totalGoals / matches).toFixed(2)}`)
console.log(`Şut ${avg(sums.shots[0])}/${avg(sums.shots[1])}  İsabet ${avg(sums.onTarget[0])}/${avg(sums.onTarget[1])}  Korner ${avg(sums.corners[0])}/${avg(sums.corners[1])}`)
console.log(`xG/maç ${avg(sums.xg[0])}/${avg(sums.xg[1])} (toplam xG ${avg(sums.xg[0] + sums.xg[1])} vs gol ${(totalGoals / matches).toFixed(2)})`)
console.log(`Pas isabeti %${((sums.passAcc[0] / matches) * 100).toFixed(0)}/%${((sums.passAcc[1] / matches) * 100).toFixed(0)}`)
console.log(`Uzun taç: ${avg(longThrows)}/maç (${longThrows} toplam)`)
console.log(`El (handball): ${avg(handballs)}/maç (${handballs} toplam)`)
console.log(`Kafa mücadelesi: ${avg(headers)}/maç  Taç: ${avg(throwIns)}/maç  Araya girme: ${avg(intercepts)}/maç`)
console.log(`Sakatlık: ${avg(injuries + manDown)}/maç, ${injSubs} sakatlık-değişikliği, ${manDown} eksik-kalma`)
