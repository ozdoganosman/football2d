import { commentaryFor } from '../commentary/templates'
import { playerInfoAt } from '../engine/roster'
import type { MatchEvent, SubRecord, TeamInfo } from '../engine/types'

// Skorboard, yorum bandı, istatistik tablosu ve olay akışı.
export class Hud {
  private teams: [TeamInfo, TeamInfo]
  private subs: SubRecord[] = []
  private events: MatchEvent[] = []
  private score: [number, number] = [0, 0]
  private shots: [number, number] = [0, 0]
  private onTarget: [number, number] = [0, 0]
  private corners: [number, number] = [0, 0]
  private fouls: [number, number] = [0, 0]
  private yellows: [number, number] = [0, 0]
  private reds: [number, number] = [0, 0]
  private offsides: [number, number] = [0, 0]
  private xg: [number, number] = [0, 0]

  private elScore = document.getElementById('score') as HTMLElement
  private elClock = document.getElementById('clock') as HTMLElement
  private elTicker = document.getElementById('ticker') as HTMLElement
  private elTickerText = document.getElementById('tickerText') as HTMLElement
  private elStats = document.getElementById('stats') as HTMLTableElement
  private elFeed = document.getElementById('feed') as HTMLElement
  private elHomePlate = document.getElementById('homePlate') as HTMLElement
  private elAwayPlate = document.getElementById('awayPlate') as HTMLElement

  private possession: [number, number] = [50, 50]

  constructor(teams: [TeamInfo, TeamInfo], subs: SubRecord[] = [], events: MatchEvent[] = []) {
    this.teams = teams
    this.subs = subs
    this.events = events
    this.reset(teams, subs, events)
  }

  reset(teams: [TeamInfo, TeamInfo], subs: SubRecord[] = [], events: MatchEvent[] = []): void {
    this.teams = teams
    this.subs = subs
    this.events = events
    this.score = [0, 0]
    this.shots = [0, 0]
    this.onTarget = [0, 0]
    this.corners = [0, 0]
    this.fouls = [0, 0]
    this.yellows = [0, 0]
    this.reds = [0, 0]
    this.offsides = [0, 0]
    this.xg = [0, 0]
    this.possession = [50, 50]
    this.elHomePlate.textContent = teams[0].name
    this.elAwayPlate.textContent = teams[1].name
    this.elHomePlate.style.background = `linear-gradient(${teams[0].color}, ${shade(teams[0].color)})`
    this.elAwayPlate.style.background = `linear-gradient(${teams[1].color}, ${shade(teams[1].color)})`
    this.elFeed.innerHTML = ''
    this.setTicker('Maç başlamak üzere...', 'neutral')
    this.renderScore()
    this.renderStats()
    this.updateClock(0)
  }

  applyEvent(e: MatchEvent, visible: boolean): void {
    const t = e.teamIdx
    switch (e.kind) {
      case 'goal':
        this.score = [e.scoreHome, e.scoreAway]
        this.addFeed(e, `GOL! ${this.eventPlayer(e)} (${this.teams[t].shortName})`, 'goal')
        break
      case 'own_goal':
        // teamIdx = golü YİYEN değil, sayıyı ALAN takım; playerId = kendi ağına
        // sokan savunmacı (rakip takımda)
        this.score = [e.scoreHome, e.scoreAway]
        this.addFeed(
          e,
          `KENDİ KALESİNE GOL! ${this.eventPlayer(e)} (${this.teams[1 - t].shortName})`,
          'goal',
        )
        break
      case 'shot_saved':
        this.shots[t]++
        this.onTarget[t]++
        break
      case 'shot_missed':
      case 'shot_blocked':
      case 'woodwork':
        this.shots[t]++
        break
      case 'corner':
        this.corners[t]++
        break
      case 'foul':
        this.fouls[t]++
        break
      case 'advantage':
        // teamIdx = avantajı alan (faule uğrayan) takım; faul rakibinde
        this.fouls[1 - t]++
        this.addFeed(e, `Avantaj: ${this.teams[t].name} oynamaya devam`, 'neutral')
        break
      case 'offside':
        this.offsides[t]++
        break
      case 'yellow_card':
        this.yellows[t]++
        this.addFeed(e, `Sarı kart: ${this.eventPlayer(e)} (${this.teams[t].shortName})`, 'yellow')
        break
      case 'red_card':
        this.reds[t]++
        this.addFeed(e, `KIRMIZI KART: ${this.eventPlayer(e)} (${this.teams[t].shortName})`, 'red')
        break
      case 'penalty_awarded':
        this.addFeed(e, `Penaltı: ${this.teams[t].name}`, 'goal')
        break
      case 'substitution':
        if (e.text) this.addFeed(e, e.text, 'neutral')
        break
      case 'injury':
        if (e.text) this.addFeed(e, e.text, 'yellow')
        break
      case 'extra_time':
        if (e.text) this.addFeed(e, e.text, 'neutral')
        break
      case 'shootout':
        if (e.text) this.addFeed(e, e.text, e.teamIdx === 0 ? 'home' : e.teamIdx === 1 ? 'away' : 'neutral')
        break
      default:
        break
    }
    // Gol sayısı şutları da arttırır (isabetli şut goldür)
    if (e.kind === 'goal') {
      this.shots[t]++
      this.onTarget[t]++
    }
    // Beklenen gol: şut olaylarına iliştirilen xG'yi biriktir
    if (e.xg && t >= 0) this.xg[t] += e.xg

    this.renderScore()
    this.renderStats()

    if (visible) {
      const text = commentaryFor(e, this.teams, this.subs, this.events)
      if (text) {
        let cls: string = e.teamIdx === 0 ? 'home' : e.teamIdx === 1 ? 'away' : 'neutral'
        if (e.kind === 'goal') cls = 'goal'
        if (e.kind === 'half_end' || e.kind === 'full_time') cls = 'neutral'
        this.setTicker(text, cls)
      }
    }
  }

  private eventPlayer(e: MatchEvent): string {
    if (e.playerId < 0) return ''
    return playerInfoAt(this.teams, this.subs, e.playerId, e.tick)?.name ?? ''
  }

  private addFeed(e: MatchEvent, text: string, cls: string): void {
    const li = document.createElement('li')
    const minute = Math.max(1, Math.ceil(e.clock / 60))
    li.textContent = `${minute}' ${text}`
    li.className = cls
    this.elFeed.prepend(li)
  }

  setTicker(text: string, cls: string): void {
    this.elTickerText.textContent = text
    this.elTicker.className = cls
  }

  updateClock(clockSec: number): void {
    const m = Math.floor(clockSec / 60)
    const s = Math.floor(clockSec % 60)
    this.elClock.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  updatePossession(homeTicks: number, awayTicks: number): void {
    const total = Math.max(1, homeTicks + awayTicks)
    this.possession = [
      Math.round((homeTicks / total) * 100),
      Math.round((awayTicks / total) * 100),
    ]
  }

  private renderScore(): void {
    this.elScore.textContent = `${this.score[0]} - ${this.score[1]}`
  }

  renderStats(): void {
    const rows: Array<[string, number | string, number | string]> = [
      ['Topla Oynama %', this.possession[0], this.possession[1]],
      ['Şut', this.shots[0], this.shots[1]],
      ['İsabetli Şut', this.onTarget[0], this.onTarget[1]],
      ['Beklenen Gol (xG)', this.xg[0].toFixed(2), this.xg[1].toFixed(2)],
      ['Korner', this.corners[0], this.corners[1]],
      ['Ofsayt', this.offsides[0], this.offsides[1]],
      ['Faul', this.fouls[0], this.fouls[1]],
      ['Sarı Kart', this.yellows[0], this.yellows[1]],
      ['Kırmızı Kart', this.reds[0], this.reds[1]],
    ]
    this.elStats.innerHTML = rows
      .map(
        ([label, h, a]) =>
          `<tr><td class="l">${h}</td><td class="c">${label}</td><td class="r">${a}</td></tr>`,
      )
      .join('')
  }
}

function shade(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.max(0, ((n >> 16) & 255) - 45)
  const g = Math.max(0, ((n >> 8) & 255) - 45)
  const b = Math.max(0, (n & 255) - 45)
  return `rgb(${r},${g},${b})`
}
