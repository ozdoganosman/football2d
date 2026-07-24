import { TICKS_PER_SEC } from './constants'
import type { HighlightWindow, MatchEvent } from './types'

const S = TICKS_PER_SEC

// Olay listesinden "önemli anlar" pencereleri: şut/gol/kart/korner/penaltı
// çevresindeki saniyeler izletilir, gerisi atlanır.
// Pozisyonun doğal başlangıcı sayılan olaylar: top el değiştirdi ya da oyun
// yeniden başladı. Pencere başlangıcı buraya çekilir ki sahne ortadan açılmasın.
const BOUNDARY_KINDS = new Set([
  'kickoff',
  'throw_in',
  'corner',
  'goal_kick',
  'free_kick',
  'offside',
  'interception',
  'tackle',
])

export function buildHighlights(events: MatchEvent[], frameCount: number): HighlightWindow[] {
  const raw: HighlightWindow[] = []

  // rawStart'tan en fazla 10 sn geriye giderek en yakın doğal sınırı bul
  const snapToBoundary = (rawStart: number): number => {
    let boundary = -1
    for (const e of events) {
      if (e.tick > rawStart) break
      if (BOUNDARY_KINDS.has(e.kind) && rawStart - e.tick <= 10 * S) {
        boundary = e.tick
      }
    }
    return boundary >= 0 ? boundary - S : rawStart
  }

  const push = (start: number, end: number): void => {
    raw.push({
      startTick: Math.max(0, Math.min(frameCount - 1, snapToBoundary(start))),
      endTick: Math.max(0, Math.min(frameCount - 1, end)),
    })
  }

  for (const e of events) {
    switch (e.kind) {
      case 'kickoff':
        // Tüm santralar gösterilir (açılış + devre başı; golden sonrakiler
        // zaten gol penceresinde). Golcü santrada oyunun yeniden başlayışı
        // izlenir.
        push(e.tick - 3 * S, e.tick + 7 * S)
        break
      case 'goal':
      case 'own_goal':
        // Golden önce + tüm gol sevinci + temiz santra: geniş pencere
        push(e.tick - 13 * S, e.tick + 19 * S)
        break
      case 'shot_saved':
      case 'shot_missed':
      case 'shot_blocked':
      case 'woodwork':
        // 13 sn öncesi: serbest vuruş/korner seremonisi de görünür
        push(e.tick - 13 * S, e.tick + 4 * S)
        break
      case 'penalty_awarded':
        // Penaltı seremonisi + vuruş + sonrası tam görünür
        push(e.tick - 8 * S, e.tick + 19 * S)
        break
      case 'corner':
        push(e.tick - 4 * S, e.tick + 13 * S)
        break
      case 'yellow_card':
      case 'red_card':
        push(e.tick - 8 * S, e.tick + 5 * S)
        break
      case 'injury':
        // Sakatlık anı + tedavi/değişiklik kısa görünür
        push(e.tick - 6 * S, e.tick + 4 * S)
        break
      case 'extra_time':
        push(e.tick - 2 * S, e.tick + 4 * S)
        break
      case 'shootout':
        // Her penaltı: koşu + vuruş + sonuç (ardışık vuruşlar birleşir)
        push(e.tick - 4 * S, e.tick + 3 * S)
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
