import {
  HALF_LENGTH,
  HALF_WIDTH,
  PENALTY_AREA_DEPTH,
  PENALTY_AREA_WIDTH,
  PENALTY_SPOT_DIST,
} from './constants'
import { vec } from './vec'
import type { MatchSim } from './engine'
import type { PlayerSim } from './types'

// Disiplin ve kadro olayları: faul, kart zarları, el, sakatlık, oyuncu
// değişikliği (planlı pencereler + zorunlu sakatlık değişimi), oyundan atılma.

// Oyuncu değişikliği pencereleri (58'/68'/78')
const SUB_WINDOWS = [58 * 60, 68 * 60, 78 * 60]

// Oyuncu değişikliği: ölü top anlarında (setupRestart) denenir. Belirli
// pencerelerde yorgun bir saha oyuncusu varsa yedekle değişir.
// İlk-onbir dizisi DEĞİŞMEZ (render için); yalnız player.info güncellenir ve
// bir SubRecord kaydı düşülür.
export function trySubstitutions(sim: MatchSim): void {
  const clock = sim.clockDisplay()
  for (let t = 0; t < 2; t++) {
    if (sim.subWindowIdx[t] >= SUB_WINDOWS.length) continue
    if (clock < SUB_WINDOWS[sim.subWindowIdx[t]]) continue
    // Pencere zamanı geçti — bu pencereyi tüket (bir daha bakma)
    sim.subWindowIdx[t]++
    if (sim.subsUsed[t] >= 3) continue
    // En yorgun saha oyuncusu (kaleci hariç), yeterince yorulmuşsa değiştir
    let out: PlayerSim | null = null
    for (const p of sim.active(t)) {
      if (p.info.role === 'GK') continue
      if (!out || p.energy < out.energy) out = p
    }
    if (!out || out.energy > 0.66) continue
    // Yedek seç: aynı rolde varsa onu, yoksa herhangi bir saha yedeği
    const bench = sim.benchPool[t]
    let bi = bench.findIndex((b) => b.role === out!.info.role)
    if (bi < 0) bi = bench.findIndex((b) => b.role !== 'GK')
    if (bi < 0) continue
    const inInfo = bench[bi]
    bench.splice(bi, 1)
    const outInfo = out.info
    out.info = inInfo
    out.energy = 1
    out.sprintReserve = 1
    out.yellows = 0
    out.tackleCooldown = 0
    out.dribbleDir = null
    sim.subsUsed[t]++
    sim.substitutions.push({ tick: sim.tick, teamIdx: t, slotIdx: out.slotIdx, inInfo })
    const text = `Oyuncu değişikliği (${sim.teams[t].shortName}): ${outInfo.name} ⬇ ${inInfo.name} ⬆`
    sim.pushEvent('substitution', t, out.id, -1, text)
  }
}

// Faul kart zarları (avantajda da uygulanır — kart avantajdan bağımsızdır)
// Kart gösterildiyse true döner (sert müdahale — sakatlık olasılığı artar)
export function rollFoulCard(sim: MatchSim, tackler: PlayerSim): boolean {
  if (sim.rng.chance(0.0025)) {
    sendOff(sim, tackler, true)
    return true
  } else if (sim.rng.chance(0.12)) {
    tackler.yellows++
    sim.yellowCards[tackler.teamIdx]++
    sim.pushEvent('yellow_card', tackler.teamIdx, tackler.id)
    if (tackler.yellows >= 2) sendOff(sim, tackler, false)
    return true
  }
  return false
}

// Zorunlu (sakatlık) oyuncu değişikliği: yedek varsa ve hak kaldıysa
// sakatlanan oyuncuyu yedekle değiştirir. Başarılıysa true.
export function forceSub(sim: MatchSim, victim: PlayerSim): boolean {
  const t = victim.teamIdx
  if (sim.subsUsed[t] >= 3) return false
  const bench = sim.benchPool[t]
  if (bench.length === 0) return false
  // Aynı rol > (kaleci sakatsa yedek kaleci) > herhangi saha yedeği
  let bi = bench.findIndex((b) => b.role === victim.info.role)
  if (bi < 0 && victim.info.role !== 'GK') bi = bench.findIndex((b) => b.role !== 'GK')
  if (bi < 0) bi = 0
  const inInfo = bench[bi]
  bench.splice(bi, 1)
  const outInfo = victim.info
  victim.info = inInfo
  victim.energy = 1
  victim.sprintReserve = 1
  victim.yellows = 0
  victim.tackleCooldown = 0
  victim.dribbleDir = null
  sim.subsUsed[t]++
  sim.substitutions.push({ tick: sim.tick, teamIdx: t, slotIdx: victim.slotIdx, inInfo })
  const text = `Sakatlık değişikliği (${sim.teams[t].shortName}): ${outInfo.name} ⬇ ${inInfo.name} ⬆`
  sim.pushEvent('substitution', t, victim.id, -1, text)
  return true
}

// Faul kurbanı sakatlanabilir. Sert müdahalede (kart) olasılık artar.
// Ciddi sakatlıkta tedavi + zorunlu değişiklik (yedek yoksa eksik kalınır);
// hafif sakatlıkta oyuncu ağrıyla azalan enerjiyle devam eder.
export function maybeInjury(sim: MatchSim, victim: PlayerSim, hard: boolean): void {
  if (!sim.rng.chance(hard ? 0.055 : 0.004)) return
  sim.addStoppage(45) // saha içi tedavi maçı uzatır
  sim.freezeUntil = Math.max(sim.freezeUntil, sim.tick + 20)
  sim.downedId = victim.id
  sim.downedUntil = Math.max(sim.downedUntil, sim.tick + 35)
  victim.vel = vec(0, 0)
  const sn = sim.teams[victim.teamIdx].shortName
  if (sim.rng.chance(0.55)) {
    // Ciddi: oyuna devam edemez
    sim.pushEvent(
      'injury',
      victim.teamIdx,
      victim.id,
      -1,
      `Sakatlık (${sn}): ${victim.info.name} oyuna devam edemiyor`,
    )
    if (forceSub(sim, victim)) {
      // Yerine taze oyuncu girdi — yerde yatan olarak gösterme
      if (sim.downedId === victim.id) sim.downedUntil = sim.tick
    } else {
      victim.sentOff = true
      victim.pos = { x: 0, y: -(HALF_WIDTH + 25) - victim.teamIdx * 3 }
      if (sim.downedId === victim.id) sim.downedUntil = sim.tick
      sim.pushEvent(
        'injury',
        victim.teamIdx,
        victim.id,
        -1,
        `${sn} sakatlık nedeniyle eksik devam ediyor`,
      )
    }
  } else {
    // Hafif: ağrıyla devam (enerji tavanı düşer)
    sim.pushEvent(
      'injury',
      victim.teamIdx,
      victim.id,
      -1,
      `Sakatlık (${sn}): ${victim.info.name} tedavi sonrası devam ediyor`,
    )
    victim.energy = Math.min(victim.energy, 0.6)
  }
}

export function handleFoul(sim: MatchSim, tacklerId: number, victimId: number): void {
  const tackler = sim.players[tacklerId]
  const victim = sim.players[victimId]
  const spot = { ...victim.pos }
  sim.fouls[tackler.teamIdx]++
  sim.addStoppage(8)
  sim.pushEvent('foul', tackler.teamIdx, tacklerId, victimId)

  // Faul okunur olsun: düdükte herkes kısa an durur, faul yiyen yerde kalır
  sim.freezeUntil = sim.tick + 9
  sim.downedId = victimId
  sim.downedUntil = sim.tick + 22
  victim.vel = vec(0, 0)

  const carded = rollFoulCard(sim, tackler)
  // Faul kurbanı sakatlanabilir (sert müdahalede daha olası); ciddi
  // sakatlıkta zorunlu değişiklik restart kurulmadan ÖNCE yapılır
  maybeInjury(sim, victim, carded)

  // Ceza sahasında mı? (müdahaleyi yapanın kendi ceza sahası)
  const att = sim.toAttack(spot, victim.teamIdx)
  const inBox =
    att.x > HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
  if (inBox) {
    sim.pushEvent('penalty_awarded', victim.teamIdx, victimId)
    const penSpot = sim.fromAttack({ x: HALF_LENGTH - PENALTY_SPOT_DIST, y: 0 }, victim.teamIdx)
    sim.setupRestart('penalty', victim.teamIdx, penSpot, 55) // seremoni için uzun
  } else {
    sim.pushEvent('free_kick', victim.teamIdx, victimId)
    // Tehlikeli (şut/orta) serbest vuruşta baraj/dizilim oturması için uzun
    // süre; derin/kısa olanlar hızlı alınır
    const fkTimer = sim.freeKickType(spot, victim.teamIdx) === 'short' ? 70 : 100
    sim.setupRestart('free_kick', victim.teamIdx, spot, fkTimer)
  }
}

// El: şutu/ortayı kolla kesen savunmacı. Hücum eden taraf yararlanır —
// ceza sahasında penaltı, dışında serbest vuruş. (Şut bloğuna bağlı,
// gerçekçi: eller çoğu zaman şut keserken devreye girer.)
export function handleHandball(sim: MatchSim, offender: PlayerSim): void {
  const forTeam = 1 - offender.teamIdx
  const spot = { ...offender.pos }
  sim.fouls[offender.teamIdx]++
  sim.addStoppage(6)
  sim.freezeUntil = sim.tick + 8
  offender.vel = vec(0, 0)
  const sn = sim.teams[offender.teamIdx].shortName
  const att = sim.toAttack(spot, forTeam)
  const inBox =
    att.x > HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
  if (inBox) {
    sim.pushEvent(
      'penalty_awarded',
      forTeam,
      offender.id,
      -1,
      `El! ${offender.info.name} (${sn}) ceza sahasında topa elle dokundu — PENALTI!`,
    )
    const penSpot = sim.fromAttack({ x: HALF_LENGTH - PENALTY_SPOT_DIST, y: 0 }, forTeam)
    sim.setupRestart('penalty', forTeam, penSpot, 55)
  } else {
    sim.pushEvent(
      'free_kick',
      forTeam,
      offender.id,
      -1,
      `El! ${offender.info.name} (${sn}) topa elle dokundu — serbest vuruş`,
    )
    const fkTimer = sim.freeKickType(spot, forTeam) === 'short' ? 70 : 100
    sim.setupRestart('free_kick', forTeam, spot, fkTimer)
  }
  // El ihlalinde bazen kart (bariz gol engelleme kırmızı olabilir — nadir)
  rollFoulCard(sim, offender)
}

export function sendOff(sim: MatchSim, p: PlayerSim, straight: boolean): void {
  sim.redCards[p.teamIdx]++
  sim.pushEvent('red_card', p.teamIdx, p.id)
  p.sentOff = true
  // Soyunma odasına: canvas dünya kutusunun dışına park edilir, çizilmez
  p.pos = { x: 0, y: HALF_WIDTH + 25 + p.teamIdx * 3 }
  if (!straight) p.yellows = 2
}
