import { TICKS_PER_SEC } from '../engine/constants'
import type { MatchEvent, MatchResult } from '../engine/types'

export type PlaybackMode = 'highlights' | 'full'

// 1x hızda saniyede izletilen oyun-saniyesi (FM 2D temposuna yakın)
const BASE_GAME_SECONDS_PER_REAL_SECOND = 3

export interface PlaybackCallbacks {
  // visible=false: önemli anlar modunda atlanan aralıktaki olay (skor/istatistik
  // güncellenir ama yorum bandında gösterilmez)
  onEvent(e: MatchEvent, visible: boolean): void
  onFinish(): void
}

export class Playback {
  playhead = 0
  playing = false
  speedMult = 1
  mode: PlaybackMode
  private result: MatchResult
  private cbs: PlaybackCallbacks
  private eventPtr = 0
  private hlIdx = 0
  finished = false

  constructor(result: MatchResult, mode: PlaybackMode, cbs: PlaybackCallbacks) {
    this.result = result
    this.mode = mode
    this.cbs = cbs
    if (mode === 'highlights' && result.highlights.length > 0) {
      this.jumpTo(result.highlights[0].startTick)
    }
  }

  setMode(mode: PlaybackMode): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === 'highlights') {
      const hls = this.result.highlights
      this.hlIdx = hls.findIndex((w) => w.endTick >= this.playhead)
      if (this.hlIdx === -1) {
        this.hlIdx = hls.length
      } else if (this.playhead < hls[this.hlIdx].startTick) {
        this.jumpTo(hls[this.hlIdx].startTick)
      }
    }
  }

  private jumpTo(tick: number): void {
    // Atlanan aralıktaki olayları görünmez işle
    this.processEvents(tick, false)
    this.playhead = tick
  }

  private processEvents(upTo: number, visible: boolean): void {
    const events = this.result.events
    while (this.eventPtr < events.length && events[this.eventPtr].tick <= upTo) {
      this.cbs.onEvent(events[this.eventPtr], visible)
      this.eventPtr++
    }
  }

  advance(dtReal: number): void {
    if (!this.playing || this.finished) return
    const delta = dtReal * BASE_GAME_SECONDS_PER_REAL_SECOND * TICKS_PER_SEC * this.speedMult
    let next = this.playhead + delta

    if (this.mode === 'highlights') {
      const hls = this.result.highlights
      const cur = hls[this.hlIdx]
      if (cur && next > cur.endTick) {
        this.processEvents(cur.endTick, true)
        this.hlIdx++
        if (this.hlIdx >= hls.length) {
          this.end()
          return
        }
        this.jumpTo(hls[this.hlIdx].startTick)
        return
      }
    }

    if (next >= this.result.frameCount - 1) {
      this.end()
      return
    }
    this.playhead = next
    this.processEvents(next, true)
  }

  private end(): void {
    this.playhead = this.result.frameCount - 1
    this.processEvents(this.playhead, true)
    this.playing = false
    this.finished = true
    this.cbs.onFinish()
  }
}
