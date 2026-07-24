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

// Golcünün bu maçtaki kaçıncı golü (kendi kalesine goller sayılmaz)
function scorerGoalNumber(allEvents: MatchEvent[], e: MatchEvent): number {
  let n = 0
  for (const ev of allEvents) {
    if (ev.tick > e.tick) break
    if (ev.kind === 'goal' && ev.playerId === e.playerId && ev.teamIdx === e.teamIdx) n++
  }
  return n
}

// Takımın son `winSec` saniyedeki şut sayısı (baskı/momentum ölçümü)
function recentShots(allEvents: MatchEvent[], e: MatchEvent, team: number, winSec: number): number {
  let n = 0
  const from = e.tick - winSec * 10
  for (const ev of allEvents) {
    if (ev.tick > e.tick) break
    if (ev.tick < from) continue
    if (ev.teamIdx !== team) continue
    if (
      ev.kind === 'goal' ||
      ev.kind === 'shot_saved' ||
      ev.kind === 'shot_missed' ||
      ev.kind === 'shot_blocked' ||
      ev.kind === 'woodwork'
    )
      n++
  }
  return n
}

export function commentaryFor(
  e: MatchEvent,
  teams: [TeamInfo, TeamInfo],
  subs: SubRecord[] = [],
  allEvents: MatchEvent[] = [],
): string | null {
  // Hazır metin (örn. oyuncu değişikliği) varsa doğrudan onu kullan
  if (e.text) return e.text
  const rng = createRng(e.tick * 7919 + 13)
  const pick = (arr: string[]): string => arr[Math.floor(rng.next() * arr.length)]
  const P = playerName(teams, subs, e.playerId, e.tick)
  const T = playerName(teams, subs, e.targetId, e.tick)
  const team = e.teamIdx >= 0 ? teams[e.teamIdx] : null
  const TN = team?.name ?? ''
  // Bağlam: geç maç, skor farkı (olayı yapan takım açısından)
  const late = e.clock >= 82 * 60
  const veryLate = e.clock >= 89 * 60
  const diff = e.teamIdx === 0 ? e.scoreHome - e.scoreAway : e.scoreAway - e.scoreHome

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
    case 'advantage':
      return pick([
        `Faul var ama hakem AVANTAJ bıraktı, ${TN} devam ediyor!`,
        `${P} faul yaptı — hakem oynat dedi, avantaj ${TN}'da!`,
      ])
    case 'yellow_card':
      return `${P} sarı kart gördü`
    case 'red_card':
      return `KIRMIZI KART! ${P} oyun dışı!`
    case 'shot_saved': {
      const pressing = recentShots(allEvents, e, e.teamIdx, 90) >= 3
      if (veryLate)
        return pick([
          `SON DAKİKA KURTARIŞI! ${P}'un şutunda ${T} takımını ayakta tuttu!`,
          `${P} beraberliği/galibiyeti bulabilirdi — ${T} müthiş çıktı!`,
        ])
      if (pressing)
        return pick([
          `${TN} baskısını sürdürüyor; ${P} vurdu, ${T} yine kurtardı!`,
          `Dalga dalga ${TN}! ${P}'un şutunu ${T} çeldi`,
        ])
      return pick([
        `${P} şutunu çekti, kaleci ${T} kurtardı!`,
        `${P} vurdu — ${T} gole izin vermedi!`,
        `Ne pozisyon! ${P}'un şutunda ${T} kurtardı`,
      ])
    }
    case 'shot_missed':
      if (diff < 0 && late)
        return pick([
          `${P} kaçırdı! ${TN} geriye düşmüşken bu büyük fırsattı`,
          `Işıl ışıl fırsat! ${P} skoru düzeltemedi`,
        ])
      return pick([`${P} vurdu, top az farkla dışarı!`, `${P} şansını denedi, isabetsiz`])
    case 'shot_blocked':
      return pick([`${P}'un şutu savunmaya çarptı`, `${P} vurdu ama şut kapandı`])
    case 'woodwork':
      return pick([
        `DİREK! ${P}'un şutu direğe çarpıp döndü!`,
        `Az kalsın! ${P}'un vuruşu üst direği yalayıp çıktı!`,
        `${P} direği buldu! Ne şanssızlık!`,
      ])
    case 'header':
      return rng.next() < 0.45
        ? null
        : pick([`${P} kafayı vurdu!`, `${P} yükseldi, kafa vuruşu!`, `Havada ${P} kazandı`])
    case 'goal': {
      const num = scorerGoalNumber(allEvents, e)
      const braceTag =
        num === 2
          ? ` ${P} bu maçtaki ikinci golünü attı!`
          : num === 3
            ? ` HAT-TRICK! ${P} üç gole ulaştı!`
            : num >= 4
              ? ` ${P} bu akşam ${num}. golünde!`
              : ''
      let lead: string
      if (diff === 0) lead = `Beraberlik golü, skor ${e.scoreHome}-${e.scoreAway}!`
      else if (diff < 0) lead = `Farkı azalttılar, skor ${e.scoreHome}-${e.scoreAway}`
      else if (diff === 1)
        lead = veryLate
          ? `Son dakikalarda ${TN} öne geçti! ${e.scoreHome}-${e.scoreAway}`
          : late
            ? `Kritik gol, ${TN} önde! ${e.scoreHome}-${e.scoreAway}`
            : `${TN} öne geçiyor, ${e.scoreHome}-${e.scoreAway}`
      else lead = `${TN} farkı açıyor, skor ${e.scoreHome}-${e.scoreAway}`
      const base = pick([
        `GOOOL!! ${P} ağları havalandırdı!`,
        `GOOOL!! ${P}'dan muhteşem bir vuruş!`,
        `GOL GELDİ! ${P} sahneye çıktı!`,
      ])
      return `${base} ${lead}.${braceTag}`
    }
    case 'own_goal':
      return pick([
        `KENDİ KALESİNE! ${P} talihsiz bir sekmeyle topu kendi ağına gönderdi! Skor ${e.scoreHome}-${e.scoreAway}`,
        `Ne talihsizlik! ${P}'dan kendi kalesine gol! ${e.scoreHome}-${e.scoreAway}`,
      ])
    case 'penalty_awarded':
      if (veryLate) return `SON DAKİKA PENALTISI! ${TN} beyaz noktadan tarihi bir şans yakaladı!`
      if (diff < 0) return `PENALTI! Geride olan ${TN} için altın fırsat, beyaz nokta!`
      return pick([`PENALTI! ${TN} beyaz noktadan yararlanacak`, `Hakem noktayı gösterdi — ${TN} penaltı kazandı!`])
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
