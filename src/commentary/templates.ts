import type { MatchEvent, SubRecord, TeamInfo } from '../engine/types'
import { createRng } from '../engine/rng'
import { playerInfoAt } from '../engine/roster'

// Olaylardan Türkçe yorum satırları. Deterministik olması için seçim,
// olayın tick'inden türetilen mini RNG ile yapılır.

function playerName(
  teams: [TeamInfo, TeamInfo],
  subs: SubRecord[],
  id: number,
  tick: number,
): string {
  if (id < 0) return ''
  return playerInfoAt(teams, subs, id, tick)?.name ?? ''
}

export function commentaryFor(
  e: MatchEvent,
  teams: [TeamInfo, TeamInfo],
  subs: SubRecord[] = [],
): string | null {
  // Hazır metin (örn. oyuncu değişikliği) varsa doğrudan onu kullan
  if (e.text) return e.text
  const rng = createRng(e.tick * 7919 + 13)
  const pick = (arr: string[]): string => arr[Math.floor(rng.next() * arr.length)]
  const P = playerName(teams, subs, e.playerId, e.tick)
  const T = playerName(teams, subs, e.targetId, e.tick)
  const team = e.teamIdx >= 0 ? teams[e.teamIdx] : null
  const TN = team?.name ?? ''

  switch (e.kind) {
    case 'kickoff':
      return pick([`${TN} santrayı kullanıyor`, `Top orta noktada, ${TN} başlatıyor`])
    case 'pass':
      // Pas çok sık; bir kısmına satır üret
      if (rng.next() < 0.5) return null
      return pick([
        `${P} topu ${T}'a aktarıyor`,
        `${P}, ${T}'ı gördü`,
        `${P} paslaşarak ilerliyor, top ${T}'da`,
        `${P} topu ileri taşıyor, adres ${T}`,
      ])
    case 'interception':
      return pick([`${P} araya girdi, top ${TN} takımında`, `${P} pası kesti!`])
    case 'tackle':
      return pick([`${P}, ${T}'dan topu sıyırdı`, `${P} müdahaleyle topu kazandı`])
    case 'foul':
      return pick([`${P} faul yaptı, ${T} yerde`, `Hakem düdüğü çaldı: ${P} faulü`])
    case 'yellow_card':
      return `${P} sarı kart gördü`
    case 'red_card':
      return `KIRMIZI KART! ${P} oyun dışı!`
    case 'shot_saved':
      return pick([
        `${P} şutunu çekti, kaleci ${T} kurtardı!`,
        `${P} vurdu — ${T} gole izin vermedi!`,
        `Ne pozisyon! ${P}'un şutunda ${T} kurtardı`,
      ])
    case 'shot_missed':
      return pick([`${P} vurdu, top az farkla dışarı!`, `${P} şansını denedi, isabetsiz`])
    case 'shot_blocked':
      return pick([`${P}'un şutu savunmaya çarptı`, `${P} vurdu ama şut kapandı`])
    case 'header':
      return rng.next() < 0.45
        ? null
        : pick([`${P} kafayı vurdu!`, `${P} yükseldi, kafa vuruşu!`, `Havada ${P} kazandı`])
    case 'goal':
      return pick([
        `GOOOL!! ${P} ağları havalandırdı! ${TN} ${e.scoreHome}-${e.scoreAway} yaptı!`,
        `GOOOL!! ${P}'dan muhteşem bir vuruş! Skor ${e.scoreHome}-${e.scoreAway}!`,
        `GOL GELDİ! ${P} skoru ${e.scoreHome}-${e.scoreAway} yapıyor!`,
      ])
    case 'own_goal':
      return pick([
        `KENDİ KALESİNE! ${P} talihsiz bir sekmeyle topu kendi ağına gönderdi! Skor ${e.scoreHome}-${e.scoreAway}`,
        `Ne talihsizlik! ${P}'dan kendi kalesine gol! ${e.scoreHome}-${e.scoreAway}`,
      ])
    case 'penalty_awarded':
      return `PENALTI! ${TN} beyaz noktadan yararlanacak`
    case 'corner':
      return pick([`Korner kazanan taraf ${TN}`, `${TN} korner kullanacak`])
    case 'throw_in':
      return rng.next() < 0.75 ? null : `Taç atışı ${TN} takımının`
    case 'goal_kick':
      return null
    case 'free_kick':
      return `Serbest vuruşu ${TN} kullanacak`
    case 'offside':
      return pick([`${P} ofsayt bayrağına takıldı`, `Yan hakem bayrağı kaldırdı: ${P} ofsaytta`])
    case 'miscontrol':
      return pick([`${P} topu kontrol edemedi!`, `${P}'un ilk dokunuşu kötü, top açıldı`])
    case 'half_end':
      return `İlk yarı sona erdi: ${teams[0].shortName} ${e.scoreHome}-${e.scoreAway} ${teams[1].shortName}`
    case 'full_time':
      return `MAÇ SONU! ${teams[0].name} ${e.scoreHome}-${e.scoreAway} ${teams[1].name}`
    default:
      return null
  }
}
