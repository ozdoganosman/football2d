import { F_CLOCK, F_POSS_AWAY, F_POSS_HOME, FRAME_STRIDE } from './engine/constants'
import { simulateMatch } from './engine/engine'
import { FORMATION_IDS } from './engine/formations'
import type { FormationId, MatchResult, TeamInfo } from './engine/types'
import { KIZILKAYA, MAVIDERE } from './data/teams'
import { Renderer } from './render/renderer'
import { renderAnalytics, type AnalyticsView } from './render/analytics'
import { Hud } from './ui/hud'
import { Playback, type PlaybackMode } from './ui/playback'

const canvas = document.getElementById('pitch') as HTMLCanvasElement
const btnNew = document.getElementById('btnNew') as HTMLButtonElement
const btnPlay = document.getElementById('btnPlay') as HTMLButtonElement
const modeSel = document.getElementById('modeSel') as HTMLSelectElement
const homeFormation = document.getElementById('homeFormation') as HTMLSelectElement
const awayFormation = document.getElementById('awayFormation') as HTMLSelectElement
const tac = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement
const homeMentality = tac('homeMentality')
const homePress = tac('homePress')
const homeWidth = tac('homeWidth')
const awayMentality = tac('awayMentality')
const awayPress = tac('awayPress')
const awayWidth = tac('awayWidth')
const seedInfo = document.getElementById('seedInfo') as HTMLElement
const speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn.speed'))

const btnAnalysis = document.getElementById('btnAnalysis') as HTMLButtonElement
const analysisOverlay = document.getElementById('analysisOverlay') as HTMLElement
const analysisCanvas = document.getElementById('analysisCanvas') as HTMLCanvasElement
const btnAnalysisClose = document.getElementById('btnAnalysisClose') as HTMLButtonElement
const analysisLegend = document.getElementById('analysisLegend') as HTMLElement
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn.av'))
const teamButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn.at'))
let analysisView: AnalyticsView = 'heat'
let analysisTeam = 0

for (const sel of [homeFormation, awayFormation]) {
  for (const f of FORMATION_IDS) {
    const opt = document.createElement('option')
    opt.value = f
    opt.textContent = f
    sel.appendChild(opt)
  }
}
homeFormation.value = KIZILKAYA.formation
awayFormation.value = MAVIDERE.formation

let result: MatchResult
let renderer: Renderer | null = null
let playback: Playback
let hud: Hud | null = null

function newMatch(): void {
  const home: TeamInfo = {
    ...KIZILKAYA,
    formation: homeFormation.value as FormationId,
    tactics: {
      mentality: Number(homeMentality.value),
      press: Number(homePress.value),
      width: Number(homeWidth.value),
    },
  }
  const away: TeamInfo = {
    ...MAVIDERE,
    formation: awayFormation.value as FormationId,
    tactics: {
      mentality: Number(awayMentality.value),
      press: Number(awayPress.value),
      width: Number(awayWidth.value),
    },
  }
  // Seed motor dışında üretilir; motor içinde tek rastgelelik kaynağı seeded RNG'dir
  const seed = (Math.random() * 0x7fffffff) | 0

  result = simulateMatch(home, away, seed)
  seedInfo.textContent = `seed: ${seed} · skor: ${result.stats.goals[0]}-${result.stats.goals[1]}`

  if (!renderer) renderer = new Renderer(canvas, result)
  else renderer.setResult(result)

  if (!hud) hud = new Hud(result.teams, result.substitutions, result.events)
  else hud.reset(result.teams, result.substitutions, result.events)

  playback = new Playback(result, modeSel.value as PlaybackMode, {
    onEvent: (e, visible) => hud?.applyEvent(e, visible),
    onFinish: () => {
      btnPlay.textContent = 'Bitti'
      btnPlay.disabled = true
    },
  })
  playback.playing = true
  playback.speedMult = currentSpeed()
  btnPlay.textContent = 'Duraklat'
  btnPlay.disabled = false
}

function currentSpeed(): number {
  const active = speedButtons.find((b) => b.classList.contains('active'))
  return active ? Number(active.dataset.speed) : 1
}

btnNew.addEventListener('click', newMatch)

btnPlay.addEventListener('click', () => {
  if (playback.finished) return
  playback.playing = !playback.playing
  btnPlay.textContent = playback.playing ? 'Duraklat' : 'Devam'
})

for (const b of speedButtons) {
  b.addEventListener('click', () => {
    speedButtons.forEach((x) => x.classList.remove('active'))
    b.classList.add('active')
    playback.speedMult = Number(b.dataset.speed)
  })
}

modeSel.addEventListener('change', () => {
  playback.setMode(modeSel.value as PlaybackMode)
})

// --- Maç analizi (ısı haritası / pas ağı) ---
function drawAnalysis(): void {
  if (!result) return
  const box = analysisOverlay.getBoundingClientRect()
  const w = Math.min(1040, Math.max(600, box.width - 40))
  const h = Math.round(w * (86 / 117))
  analysisCanvas.width = w
  analysisCanvas.height = h
  renderAnalytics(analysisCanvas, result, analysisView, analysisTeam)
  const teamName = result.teams[analysisTeam].name
  analysisLegend.textContent =
    analysisView === 'heat'
      ? `${teamName} — top nerede olursa olsun oyuncuların bulunduğu bölgeler (mavi az, kırmızı yoğun)`
      : `${teamName} — düğüm = ortalama konum (boyu pas hacmi), çizgi = çiftler arası pas sıklığı`
}

function openAnalysis(): void {
  analysisOverlay.classList.remove('hidden')
  drawAnalysis()
}

btnAnalysis.addEventListener('click', openAnalysis)
btnAnalysisClose.addEventListener('click', () => analysisOverlay.classList.add('hidden'))
analysisOverlay.addEventListener('click', (e) => {
  if (e.target === analysisOverlay) analysisOverlay.classList.add('hidden')
})
for (const b of viewButtons) {
  b.addEventListener('click', () => {
    viewButtons.forEach((x) => x.classList.remove('active'))
    b.classList.add('active')
    analysisView = b.dataset.view as AnalyticsView
    drawAnalysis()
  })
}
for (const b of teamButtons) {
  b.addEventListener('click', () => {
    teamButtons.forEach((x) => x.classList.remove('active'))
    b.classList.add('active')
    analysisTeam = Number(b.dataset.team)
    drawAnalysis()
  })
}

window.addEventListener('resize', () => renderer?.resize())

let lastT = performance.now()
function loop(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000)
  lastT = now
  if (playback && renderer && hud) {
    playback.advance(dt)
    renderer.draw(playback.playhead)
    const f = Math.floor(playback.playhead) * FRAME_STRIDE
    hud.updateClock(result.frames[f + F_CLOCK])
    hud.updatePossession(result.frames[f + F_POSS_HOME], result.frames[f + F_POSS_AWAY])
    hud.renderStats()
  }
  requestAnimationFrame(loop)
}

newMatch()
requestAnimationFrame(loop)
