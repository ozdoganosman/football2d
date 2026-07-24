// Sarsıntı (jitter) ölçümü: kare verisinden hız türetip Δv, ters dönme ve
// donma-patlama sayar. Hareket akıcılığı değişikliklerini doğrulamak için.
// Kullanım: npm run jitter -- --matches 2
import { simulateMatch } from '../engine/engine'
import { KIZILKAYA, MAVIDERE } from '../data/teams'
import { F_PLAYERS, FRAME_STRIDE, TICK_DT } from '../engine/constants'

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1])
  return def
}

const N = arg('matches', 2)
const dvs: number[] = []
let reversals = 0
let moving = 0
let freezeBurst = 0

for (let m = 0; m < N; m++) {
  const r = simulateMatch(KIZILKAYA, MAVIDERE, 1 + m)
  const { frames, frameCount } = r
  const at = (t: number, id: number): [number, number] => [
    frames[t * FRAME_STRIDE + F_PLAYERS + id * 2],
    frames[t * FRAME_STRIDE + F_PLAYERS + id * 2 + 1],
  ]
  for (let id = 0; id < 22; id++) {
    let pvx = 0
    let pvy = 0
    for (let t = 2; t < frameCount; t++) {
      const [x1, y1] = at(t - 1, id)
      const [x2, y2] = at(t, id)
      const vx = (x2 - x1) / TICK_DT
      const vy = (y2 - y1) / TICK_DT
      const sp = Math.hypot(vx, vy)
      const psp = Math.hypot(pvx, pvy)
      // 40 m/s üstü: devre arası yeniden dizilim/saha dışına park — ölçüme girmez
      if (t > 2 && sp < 40 && psp < 40) {
        dvs.push(Math.hypot(vx - pvx, vy - pvy))
        if (sp > 2 && psp > 2) {
          moving++
          const cos = (vx * pvx + vy * pvy) / (sp * psp)
          if (cos < -0.5) reversals++ // >120° yön değişimi (mekik)
        }
        if (psp < 0.5 && sp > 3) freezeBurst++ // donma → patlama
      }
      pvx = vx
      pvy = vy
    }
  }
}

dvs.sort((a, b) => a - b)
const q = (f: number): string => dvs[Math.floor(dvs.length * f)].toFixed(2)
console.log(
  `Δv p50 ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)} m/s | ` +
    `ters dönme %${((reversals / Math.max(1, moving)) * 100).toFixed(2)} | ` +
    `donma-patlama ${freezeBurst}`,
)
