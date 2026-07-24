import type { PlayerInfo, SubRecord, TeamInfo } from './types'

// Bir oyuncu id'sinin (0..21) verilen tick'te sahadaki gerçek PlayerInfo'su.
// Kare-slot eşlemesi zamandan bağımsız olduğu için, oynatma/istatistik/yorum
// katmanı ismi ve numarayı buradan çözer: ilk onbirden başlar, o slota o
// tick'e kadar yapılmış en son değişikliği uygular.
export function playerInfoAt(
  teams: [TeamInfo, TeamInfo],
  subs: SubRecord[],
  id: number,
  tick: number,
): PlayerInfo {
  const teamIdx = id < 11 ? 0 : 1
  const slotIdx = id % 11
  let info = teams[teamIdx].starters[slotIdx]
  let bestTick = -1
  for (const s of subs) {
    if (s.teamIdx === teamIdx && s.slotIdx === slotIdx && s.tick <= tick && s.tick > bestTick) {
      bestTick = s.tick
      info = s.inInfo
    }
  }
  return info
}
