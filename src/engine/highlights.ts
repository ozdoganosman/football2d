import { TICKS_PER_SEC } from './constants'
import type { HighlightWindow, MatchEvent } from './types'

const S = TICKS_PER_SEC

// Olay listesinden "önemli anlar" pencereleri: şut/gol/kart/korner/penaltı
// çevresindeki saniyeler izletilir, gerisi atlanır.
export function buildHighlights(events: MatchEvent[], frameCount: number): HighlightWindow[] {
  const raw: HighlightWindow[] = []
  const push = (start: number, end: number): void => {
    raw.push({
      startTick: Math.max(0, Math.min(frameCount - 1, start)),
      endTick: Math.max(0, Math.min(frameCount - 1, end)),
    })
  }

  for (const e of events) {
    switch (e.kind) {
      case 'kickoff':
        if (e.tick < 5 * S) push(0, e.tick + 8 * S) // maç açılışı
        break
      case 'goal':
        push(e.tick - 14 * S, e.tick + 10 * S)
        break
      case 'shot_saved':
      case 'shot_missed':
      case 'shot_blocked':
        push(e.tick - 11 * S, e.tick + 4 * S)
        break
      case 'penalty_awarded':
        push(e.tick - 8 * S, e.tick + 12 * S)
        break
      case 'corner':
        push(e.tick - 4 * S, e.tick + 12 * S)
        break
      case 'yellow_card':
      case 'red_card':
        push(e.tick - 8 * S, e.tick + 5 * S)
        break
      case 'half_end':
      case 'full_time':
        push(e.tick - 6 * S, e.tick + 1)
        break
      default:
        break
    }
  }

  raw.sort((a, b) => a.startTick - b.startTick)

  // Örtüşen / yakın pencereleri birleştir
  const merged: HighlightWindow[] = []
  const GAP = 3 * S
  for (const w of raw) {
    const last = merged[merged.length - 1]
    if (last && w.startTick <= last.endTick + GAP) {
      last.endTick = Math.max(last.endTick, w.endTick)
    } else {
      merged.push({ ...w })
    }
  }
  return merged
}
