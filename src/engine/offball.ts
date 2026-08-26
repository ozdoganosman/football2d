import { HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH, PENALTY_AREA_WIDTH } from './constants'
import { energyFactor, maxSpeed } from './attributes'
import { agilityFactor, sprintCap } from './stamina'
import { targetPosition } from './positioning'
import { add, dist, norm, scale, sub, vec } from './vec'
import type { MatchSim } from './engine'
import type { PlayerSim, Vec2 } from './types'

// Topsuz oyun alt sistemi: FM tarzı görev atamaları (topa giden tek görevli,
// cover, markaj), topsuz koşular (cep/derin, ver-kaç, bindirme), hat kuralları
// ve tüm oyuncuların tick hareketi.

// Yuvarlanan topla buluşma noktası: oyuncunun yetişebileceği EN ERKEN yol
// noktası (top sabit 1.5 m/s² yavaşlamayla ilerler; kavis ihmal edilir).
// Topun arkasından kovalamak yerine önünü kesmek — alıcı pası böyle alır.
export function meetRollingBall(sim: MatchSim, p: PlayerSim, maxSpd: number): Vec2 {
  if (sim.ball.kind !== 'rolling') return sim.ballPos()
  const b = sim.ball
  const v0 = Math.hypot(b.vel.x, b.vel.y)
  if (v0 < 0.3) return { ...b.pos }
  const dir = { x: b.vel.x / v0, y: b.vel.y / v0 }
  const tStop = v0 / 1.5
  // Oyuncunun t saniyede kat edebileceği yol: ivme tavanı (13 m/s²)
  // hesaba katılır — duran oyuncu ilk anda ışınlanamaz
  const tA = maxSpd / 45
  const reach = (t: number) => (t < tA ? 22.5 * t * t : maxSpd * (t - tA / 2))
  for (let t = 0.2; t <= 3; t += 0.2) {
    const tc = Math.min(t, tStop)
    const s = v0 * tc - 0.75 * tc * tc
    const pos = { x: b.pos.x + dir.x * s, y: b.pos.y + dir.y * s }
    if (dist(p.pos, pos) <= reach(t) + 0.4) return pos
  }
  const sEnd = v0 * tStop - 0.75 * tStop * tStop
  return { x: b.pos.x + dir.x * sEnd, y: b.pos.y + dir.y * sEnd }
}

// Havadan topun tahmini DURUŞ noktası: iniş + sekme/yuvarlanma payı.
// Alıcı ve görevli iniş noktasına değil topun gerçekten duracağı yere koşar
// (gerçek oyuncular sekmeyi okur) — balistik toplara karşı AI kör kalmaz.
export function aerialSettlePoint(sim: MatchSim): Vec2 {
  const b = sim.ball
  if (b.kind !== 'inFlight' || b.flight === 'shot' || !b.bVel) return sim.ballPos()
  const v = Math.hypot(b.bVel.x, b.bVel.y)
  if (v < 0.3) return { ...b.to }
  const absorb = b.flight === 'pass' ? 0.35 : b.flight === 'cross' ? 0.45 : 0.5
  const cap = b.flight === 'pass' ? 4.5 : b.flight === 'cross' ? 6 : 7
  // İki sekme sonrası yaklaşık hız → yuvarlanma mesafesi (a = 1.5 m/s²)
  const vSettle = Math.min(cap, v * absorb * absorb)
  const hop = v * absorb * 0.5 // sekme sıçramalarının yatay yolu (kaba)
  const roll = (vSettle * vSettle) / (2 * 1.5)
  const ux = b.bVel.x / v
  const uy = b.bVel.y / v
  return {
    x: Math.max(-HALF_LENGTH + 1, Math.min(HALF_LENGTH - 1, b.to.x + ux * (hop + roll * 0.6))),
    y: Math.max(-HALF_WIDTH + 1, Math.min(HALF_WIDTH - 1, b.to.y + uy * (hop + roll * 0.6))),
  }
}

// Rakip blok hatları (attTeam'in hücum çerçevesinde): savunma hattı =
// ofsayt çizgisi, orta saha hattı = rakip MF'lerin medyan derinliği.
// pocket = iki blok arasındaki cebin derinliği (m)
export function oppLines(sim: MatchSim, attTeam: number): { mfLine: number; dfLine: number; pocket: number } {
  const dfLine = sim.offsideLine(attTeam)
  const xs: number[] = []
  for (const o of sim.active(1 - attTeam)) {
    if (o.info.role === 'MF') xs.push(sim.toAttack(o.pos, attTeam).x)
  }
  xs.sort((a, b) => a - b)
  const mfLine = xs.length ? xs[Math.floor(xs.length / 2)] : dfLine - 20
  return { mfLine, dfLine, pocket: dfLine - mfLine }
}

// FM tarzı görev sistemi: topa takım başına TEK oyuncu gider (first
// defender). Aday seçimi maliyete dayanır: mesafe + rolün doğal bölgesine
// uygunluk (DF geride, MF ortada, FW ileride karşılar). Histerezis, görevin
// her tick el değiştirmesini önler; böylece "hep aynı iki oyuncu koşuyor"
// görüntüsü de, sürü halinde topa gitme de biter.
export function assignEngager(
  sim: MatchSim,
  teamIdx: number,
  focus: Vec2,
  maxRange: number,
  allowGk = false,
): number {
  const focusAtt = sim.toAttack(focus, teamIdx)
  let bestId = -1
  let bestCost = Infinity
  for (const p of sim.active(teamIdx)) {
    if (p.info.role === 'GK' && !allowGk) continue
    const d = dist(p.pos, focus)
    if (d > maxRange) continue
    // Santraforlar baskıya isteksizdir: yalnız çok yüksek toplara giderler
    const depthPref = p.info.role === 'DF' ? -22 : p.info.role === 'MF' ? -2 : 26
    let cost = d + Math.abs(focusAtt.x - depthPref) * 0.22
    // Kademe: kale tarafındaki aday tercih edilir — arkadan kovalayan
    // varken önden biri ÇIKAR, hat kaleye kadar geri kaçmaz
    const pAtt = sim.toAttack(p.pos, teamIdx)
    // Tehlike bölgesinde (kaleye <30 m) görevlilik arkadan kovalayana
    // KALMAZ: kale tarafında olmayan aday ağır ceza yer
    const nearGoal = focusAtt.x < -HALF_LENGTH + 30
    if (pAtt.x > focusAtt.x) cost += nearGoal ? 12 : 6
    // Çalım yemiş / müdahalesi boşa çıkmış oyuncu görevden düşer:
    // kademedeki oyuncu birinci adam olarak devralır
    if (p.tackleCooldown > 0.4) cost += 9
    if (p.id === sim.engagerId[teamIdx]) cost *= 0.72
    if (cost < bestCost) {
      bestCost = cost
      bestId = p.id
    }
  }
  sim.engagerId[teamIdx] = bestId
  return bestId
}

export function movePlayers(sim: MatchSim, dt: number): void {
  const bp = sim.ballPos()
  const possTeam = sim.possTeam()
  const carrierId = sim.controllerId()

  // Görev atamaları (FM modeli): topa yalnız görevli gider, bir oyuncu
  // arkasını alır, kalanlar markaj yapar ya da şekli korur.
  const overrides = new Map<number, { target: Vec2; sprint: boolean }>()
  let defTeam = -1

  if (carrierId >= 0) {
    const carrier = sim.players[carrierId]
    defTeam = 1 - carrier.teamIdx
    const ballAttDef = sim.toAttack(bp, defTeam)
    // Top kendi yarı sahasına yaklaştıysa sert angajman; rakip sahadaysa
    // mesafeli karşılama (bekler, dalmaz) — full saha pres yok
    // Taktik pres: yüksek pres daha ileride sert angajmana geçer (0 = dengeli)
    const aggressive = ballAttDef.x < 8 + sim.effTactics[defTeam].press * 10
    const engager = assignEngager(sim, defTeam, carrier.pos, aggressive ? 24 : 15)
    if (engager >= 0) {
      const e = sim.players[engager]
      const d = dist(e.pos, carrier.pos)
      if (aggressive) {
        // Kale tarafı ofseti mesafeyle SÜREKLİ erir (3.5 m'de tam, temas
        // halkasında sıfır) — sınırda hedef zıplaması mücadele titremesi
        // yaratıyordu (ikili anahtar 2.5 m'de 1.5 m sıçratırdı)
        const goalOff = -1.5 * Math.min(1, Math.max(0, (d - 2.0) / 1.5))
        let t = add(carrier.pos, sim.fromAttack({ x: goalOff, y: 0 }, defTeam))
        // Yakın mesafede hedef taşıyıcının ÜSTÜ değil temas halkasının
        // üstündeki nokta olur: çarpışma tabanına her tick gömülüp geri
        // itilme (titreme) biter — müdahale menzili (2.4) yine dolu
        if (d < 3.2 && d > 1e-6) {
          const ringT = add(carrier.pos, scale(norm(sub(e.pos, carrier.pos)), 1.95))
          const w = Math.min(1, (3.2 - d) / 1.2)
          t = { x: t.x + (ringT.x - t.x) * w, y: t.y + (ringT.y - t.y) * w }
        }
        overrides.set(engager, { target: t, sprint: true })
      } else {
        // top ile kendi kalesi arasında pozisyon alıp bekler; forvetse
        // daha da mesafeli durur (isteksiz baskı)
        const standDist = e.info.role === 'FW' ? -4.5 : -3.2
        const stand = add(carrier.pos, sim.fromAttack({ x: standDist, y: 0 }, defTeam))
        overrides.set(engager, { target: stand, sprint: d > 7 })
      }
      // Kutu acil durumu: top kendi ceza sahasındaysa ikinci adam da topa
      // gider (kutuda seyredilmez); değilse ikinci adam cover pozisyonu alır
      const inOwnBox =
        ballAttDef.x < -HALF_LENGTH + PENALTY_AREA_DEPTH &&
        Math.abs(ballAttDef.y) < PENALTY_AREA_WIDTH / 2 + 3
      let second: PlayerSim | null = null
      let secondD = inOwnBox ? 12 : 14
      for (const q of sim.active(defTeam)) {
        if (q.id === engager || q.info.role === 'GK') continue
        const dd = dist(q.pos, carrier.pos)
        if (dd < secondD) {
          secondD = dd
          second = q
        }
      }
      if (second) {
        if (inOwnBox) {
          // Halka üstü yaklaşma noktası: taşıyıcının üstüne değil temas
          // mesafesine koş (tabana gömülme titremesi olmaz)
          const toS =
            dist(second.pos, carrier.pos) > 1e-6
              ? norm(sub(second.pos, carrier.pos))
              : vec(1, 0)
          overrides.set(second.id, { target: add(carrier.pos, scale(toS, 1.95)), sprint: true })
        } else {
          // Kademe: ikinci adam top ile KENDİ KALESİ arasındaki hat üzerinde,
          // görevlinin ~5.5 m gerisinde açıyla durur — görevli geçilirse
          // önünde o var
          const ownGoal = vec(-HALF_LENGTH * sim.attackDir[defTeam], 0)
          const coverPoint = add(
            carrier.pos,
            scale(norm(sub(ownGoal, carrier.pos)), 5.5),
          )
          overrides.set(second.id, { target: coverPoint, sprint: false })
        }
      }
    }

    // STOPER ALARMI: taşıyıcı kaleye 30 m yaklaştıysa ve görevli kale
    // tarafında değilse (yalnız arkadan kovalanıyorsa), en yakın öndeki
    // stoper çıkıp taşıyıcı-kale hattını DOĞRUDAN kapatır
    const ownGoalPos = sim.fromAttack({ x: -HALF_LENGTH, y: 0 }, defTeam)
    const goalDistA = dist(carrier.pos, ownGoalPos)
    if (goalDistA < 30) {
      const eng = sim.engagerId[defTeam]
      const engOk =
        eng >= 0 && sim.toAttack(sim.players[eng].pos, defTeam).x < ballAttDef.x - 0.5
      if (!engOk) {
        let stopper: PlayerSim | null = null
        let sd = 25
        for (const q of sim.active(defTeam)) {
          if (q.info.role !== 'DF') continue
          if (sim.toAttack(q.pos, defTeam).x >= ballAttDef.x) continue
          const dd = dist(q.pos, carrier.pos)
          if (dd < sd) {
            sd = dd
            stopper = q
          }
        }
        if (stopper) {
          // 2.1 m: temas tabanının (2.0) hemen dışı — içine hedeflenirse
          // her tick gömül/itil döngüsü titretir
          overrides.set(stopper.id, {
            target: add(carrier.pos, scale(norm(sub(ownGoalPos, carrier.pos)), 2.1)),
            sprint: true,
          })
        }
      }
    }

    // TOPSUZ KOŞU SEÇİMİ: bloklar arası cep varsa bir koşucu oraya iner;
    // savunma hattının arkasında alan varsa bir koşucu da çizgiye yapışıp
    // ARKAYA fırlamak için derin koşu görevi alır. Kanallar topun iki
    // yanındaki yarı boşluklardır; pencere boyunca kanal sabit kalır
    // (koşunun bir yönü olur), pencere dolunca tazelenir.
    const attTeam = carrier.teamIdx
    const ballAttA = sim.toAttack(bp, attTeam)
    const lines = oppLines(sim, attTeam)
    const pocketOk = lines.pocket >= 7
    // Hat kutu önüne çakılmamışsa arkasında koşulacak alan var demektir;
    // derin koşu topun gerisinden anlamsız — top ilerideyken kurulur
    const behindOk = HALF_LENGTH - 16.5 - lines.dfLine > 9 && ballAttA.x > -2
    if ((pocketOk || behindOk) && ballAttA.x > -12 && ballAttA.x < lines.dfLine) {
      if (sim.pocketRun.team !== attTeam || sim.tick >= sim.pocketRun.until) {
        const laneY = (side: 1 | -1) =>
          Math.max(-22, Math.min(22, ballAttA.y * 0.35 + side * 8.5))
        const laneSpace = (y: number) => {
          const spot = sim.fromAttack({ x: (lines.mfLine + lines.dfLine) / 2, y }, attTeam)
          let m = 99
          for (const o of sim.active(defTeam)) m = Math.min(m, dist(o.pos, spot))
          return m
        }
        const y1 = laneY(1)
        const y2 = laneY(-1)
        const lanes: [number, number] = laneSpace(y1) >= laneSpace(y2) ? [y1, y2] : [y2, y1]
        // İlk koşucu cebe (varsa), ikincisi defans arkasına (varsa) —
        // ikisi de varsa hem hat arası hem derinlik aynı anda tehdit edilir
        const modes: ['pocket' | 'behind', 'pocket' | 'behind'] = [
          pocketOk ? 'pocket' : 'behind',
          behindOk ? 'behind' : 'pocket',
        ]
        const ids: [number, number] = [-1, -1]
        const used = new Set<number>()
        for (let li = 0; li < 2; li++) {
          const spotX =
            modes[li] === 'behind' ? lines.dfLine - 0.5 : lines.mfLine + lines.pocket * 0.55
          const spot = sim.fromAttack({ x: spotX, y: lanes[li] }, attTeam)
          let bestD = 26
          for (const m of sim.active(attTeam)) {
            if (m.id === carrierId || m.info.role === 'GK' || m.info.role === 'DF') continue
            if (used.has(m.id) || overrides.has(m.id)) continue
            const dd = dist(m.pos, spot)
            if (dd < bestD) {
              bestD = dd
              ids[li] = m.id
            }
          }
          if (ids[li] >= 0) used.add(ids[li])
        }
        // Kumar koşusu: derin koşucu ~%25 pencerede çizgiyi ihlal edecek kadar
        // erken fırlar — ara pası tam zamanlıysa golle, değilse bayrakla biter
        sim.pocketRun = { team: attTeam, ids, lanes, modes, until: sim.tick + 35, gamble: sim.rng.chance(0.35) }
      }
    }

    // Pas açısı desteği: taşıyıcı baskı altındaysa en yakın iki takım
    // arkadaşı kısa pas seçeneği yaratacak açılara iner (boşa çıkma)
    let nearestDef = 99
    for (const q of sim.active(defTeam)) {
      nearestDef = Math.min(nearestDef, dist(q.pos, carrier.pos))
    }
    if (nearestDef < 4) {
      const goalDir = norm(
        sub(vec(HALF_LENGTH * sim.attackDir[carrier.teamIdx], 0), carrier.pos),
      )
      const perp = vec(-goalDir.y, goalDir.x)
      const back = add(carrier.pos, scale(goalDir, -3))
      const s1 = add(back, scale(perp, 9))
      const s2 = add(back, scale(perp, -9))
      const mates = sim
        .active(carrier.teamIdx)
        .filter(
          (m) =>
            m.id !== carrier.id &&
            m.info.role !== 'GK' &&
            // cebe koşan oyuncu kısa destek için koşusundan koparılmaz
            !(sim.pocketRun.team === carrier.teamIdx && sim.pocketRun.ids.includes(m.id)),
        )
        .sort((a, b) => dist(a.pos, carrier.pos) - dist(b.pos, carrier.pos))
        .slice(0, 2)
      if (mates[0]) {
        const first = dist(mates[0].pos, s1) <= dist(mates[0].pos, s2) ? s1 : s2
        overrides.set(mates[0].id, { target: first, sprint: false })
        if (mates[1]) {
          overrides.set(mates[1].id, { target: first === s1 ? s2 : s1, sprint: false })
        }
      }
    }
  } else if (sim.ball.kind === 'inFlight' && sim.ball.flight !== 'shot') {
    const b = sim.ball
    defTeam = 1 - sim.players[b.byId].teamIdx
    // Alıcı ve görevli topun tahmini DURUŞ noktasına koşar (sekme payı dahil)
    const settle = aerialSettlePoint(sim)
    if (b.targetId !== null && !sim.players[b.targetId].sentOff) {
      overrides.set(b.targetId, { target: settle, sprint: true })
    }
    // Savunmadan yalnız yetişebilecek TEK görevli duruş noktasına gider
    const remaining = Math.max(0, 1 - b.t) * b.duration
    const reach = remaining * 7.5 + 8
    const engager = assignEngager(sim, defTeam, settle, reach)
    if (engager >= 0) overrides.set(engager, { target: settle, sprint: true })
    // Alıcının markajcısı adamıyla birlikte topa gider: alıcıya en yakın
    // savunmacı da iniş noktasına koşar (adam takibi — sürü değil)
    if (b.targetId !== null) {
      const recv = sim.players[b.targetId]
      let tracker: PlayerSim | null = null
      let trackerD = 8
      for (const q of sim.active(defTeam)) {
        if (q.info.role === 'GK' || q.id === engager) continue
        const dd = dist(q.pos, recv.pos)
        if (dd < trackerD) {
          trackerD = dd
          tracker = q
        }
      }
      if (tracker) {
        // Markajcı iniş noktasının YANINA gelir: topun uçuş/yuvarlanma
        // hattının üstünde durmak her hafif uzun pası otomatik çalardı.
        // Dik açılım kale tarafına doğru seçilir (savunma içgüdüsü doğru,
        // hat temiz kalır); görevli de oradaysa daha geniş açılır
        const closeToEng =
          engager >= 0 && dist(tracker.pos, sim.players[engager].pos) < 3
        const pd = norm(sub(b.to, b.from))
        const perp = vec(-pd.y, pd.x)
        const ownG = sim.fromAttack({ x: -HALF_LENGTH, y: 0 }, defTeam)
        const side = (ownG.x - b.to.x) * perp.x + (ownG.y - b.to.y) * perp.y > 0 ? 1 : -1
        const wide = closeToEng ? 2.6 : 1.5
        overrides.set(tracker.id, { target: add(b.to, scale(perp, side * wide)), sprint: true })
      }
    }
    // Degaj/uzun top (hedefsiz): hücum eden taraftan da tek oyuncu gider
    if (b.targetId === null) {
      const att = assignEngager(sim, 1 - defTeam, settle, 34)
      if (att >= 0) overrides.set(att, { target: settle, sprint: true })
    }
  } else if (sim.ball.kind === 'rolling') {
    // Boş top: takım başına yalnız en uygun TEK oyuncu (kendi ceza
    // sahasındaysa kaleci de aday). Pas yeni çıktıysa savunan takım
    // 0.5 sn tepki gecikmesiyle harekete geçer — pasa ışınlanılmaz
    const chase = add(bp, scale(sim.ball.vel, 0.3))
    const piFresh = sim.passIntent
    for (let t = 0; t < 2; t++) {
      // Tepki gecikmesi kendi savunma üçlüsünde YOK: kutu önünde
      // savunmacı pasa hazır bekler, orta sahada geç kalır
      if (piFresh && t !== piFresh.team && sim.tick - piFresh.tick < 3) {
        if (sim.toAttack(bp, t).x > -HALF_LENGTH / 3) continue
      }
      const att = sim.toAttack(bp, t)
      const inOwnBox =
        att.x < -HALF_LENGTH + PENALTY_AREA_DEPTH && Math.abs(att.y) < PENALTY_AREA_WIDTH / 2
      const engager = assignEngager(sim, t, chase, 28, inOwnBox)
      if (engager >= 0) overrides.set(engager, { target: chase, sprint: true })

      // SWEEPER-KECİ: savunma hattının ARKASINA düşen boş topa kaleci çıkıp
      // süpürür. Top kendi üçte birinde + merkezi + son savunmacıdan daha
      // derinde ve kaleci hücumcuyla yarışabilecek kadar yakınsa sprint eder.
      const gk = sim.keeperOf(t)
      if (gk && sim.ball.controllerId < 0) {
        const bAtt = sim.toAttack(chase, t)
        let lastDefX = 0
        for (const d of sim.active(t)) {
          if (d.info.role === 'GK') continue
          lastDefX = Math.min(lastDefX, sim.toAttack(d.pos, t).x)
        }
        const behindLine = bAtt.x < lastDefX - 1
        const dangerZone = bAtt.x < -HALF_LENGTH + 24 && Math.abs(bAtt.y) < 20
        if (behindLine && dangerZone) {
          const gkDist = dist(gk.pos, chase)
          let nearestAtt = 99
          for (const o of sim.active(1 - t)) nearestAtt = Math.min(nearestAtt, dist(o.pos, chase))
          // Kaleci topa yetişebilecekse ve rakipten geç kalmayacaksa çık
          if (gkDist < 17 && gkDist <= nearestAtt + 2.5) {
            overrides.set(gk.id, { target: chase, sprint: true })
          }
        }
      }
    }

    // Yerden pas yolda: alıcı topu karşılamaya koşar, alıcının markajcısı
    // da onunla gider (savunma markaj/şekil düzeni pas boyunca aktif)
    const pi = sim.passIntent
    if (pi && !sim.players[pi.targetId].sentOff) {
      // Alıcı topu ÖNÜNDEN karşılar: arkadan kovalarsa (ivme gerçekçi
      // olduğundan) yetişemez ve pas yolda kesilir
      const recv0 = sim.players[pi.targetId]
      const pursuit = meetRollingBall(
        sim,
        recv0,
        maxSpeed(recv0.info.attributes) * energyFactor(recv0.energy),
      )
      overrides.set(pi.targetId, { target: pursuit, sprint: true })
      defTeam = 1 - pi.team
      const recv = sim.players[pi.targetId]
      let tracker: PlayerSim | null = null
      let trackerD = 8
      for (const q of sim.active(defTeam)) {
        if (q.info.role === 'GK' || q.id === sim.engagerId[defTeam]) continue
        const dd = dist(q.pos, recv.pos)
        if (dd < trackerD) {
          trackerD = dd
          tracker = q
        }
      }
      if (tracker) {
        const eng = sim.engagerId[defTeam]
        // Topun yuvarlanma hattının YANINA açıl (hattın üstü = otomatik
        // araya girme); açılım kale tarafına doğru, alıcıya binme yok
        const closeToEng2 = eng >= 0 && dist(tracker.pos, sim.players[eng].pos) < 3
        const bv = Math.hypot(sim.ball.vel.x, sim.ball.vel.y)
        const pd = bv > 0.3 ? scale(sim.ball.vel, 1 / bv) : vec(1, 0)
        const perp = vec(-pd.y, pd.x)
        const ownG = sim.fromAttack({ x: -HALF_LENGTH, y: 0 }, defTeam)
        const side = (ownG.x - pursuit.x) * perp.x + (ownG.y - pursuit.y) * perp.y > 0 ? 1 : -1
        const wide = closeToEng2 ? 2.6 : 1.5
        overrides.set(tracker.id, {
          target: add(pursuit, scale(perp, side * wide)),
          sprint: true,
        })
      }
    }
  }

  // TOPSUZ KOŞU HEDEFLERİ: cep koşucusu bloklar arasına iner, derin
  // koşucu savunma hattına yapışıp arkaya fırlamak için çizgide sürer
  // (çizgi dansı). Pas yoldayken de koşu sürer (topu bekleyerek
  // durulmaz); hatlar kayınca hedef her tick tazelenir, kanal sabittir.
  if (sim.pocketRun.until > sim.tick && sim.pocketRun.team >= 0) {
    const runTeam = sim.pocketRun.team
    if (possTeam === runTeam || possTeam < 0) {
      const lines = oppLines(sim, runTeam)
      for (let li = 0; li < 2; li++) {
        const rid = sim.pocketRun.ids[li]
        if (rid < 0 || rid === carrierId || overrides.has(rid)) continue
        const r = sim.players[rid]
        if (r.sentOff) continue
        const mode = sim.pocketRun.modes[li]
        let x: number
        if (mode === 'behind') {
          // Derin koşu: ofsayt çizgisinin hemen gerisinde kal — ara pası
          // gelirse koşu yoluna pas onu hattın ARKASINA taşır. Kumar
          // koşusunda çizginin üstüne taşar (zamanlama hatası → ofsayt riski)
          x = Math.max(lines.dfLine - 0.5, lines.mfLine + 2)
          if (sim.pocketRun.gamble) x = lines.dfLine + 1.7
        } else {
          if (lines.pocket < 4) continue // cep kapandı, koşuyu zorlamaz
          const rAttX = sim.toAttack(r.pos, runTeam).x
          // Hattın üstünde bekleyen adam cebe GERİ iner (topa dönük pas
          // ister), derindeki adam cebe ÇIKAR (hat arasına dalar)
          const depth =
            rAttX > lines.dfLine - 1
              ? lines.mfLine + lines.pocket * 0.4
              : lines.mfLine + lines.pocket * 0.65
          x = Math.min(Math.max(depth, lines.mfLine + 1.5), lines.dfLine - 1.5)
        }
        const target = sim.fromAttack({ x, y: sim.pocketRun.lanes[li] }, runTeam)
        overrides.set(rid, { target, sprint: dist(r.pos, target) > 3 })
      }
    }
  }

  // VER-KAÇ KOŞUSU: duvar pasını atan oyuncu topu verir vermez markörünün
  // boş yanından öne fırlar (ofsayt çizgisinin gerisinde kalır). Alıcı geri
  // pası öncelediği için bu, klasik ikili paslaşmayı tamamlar.
  if (sim.oneTwo && sim.tick < sim.oneTwo.until && (possTeam === sim.oneTwo.team || possTeam < 0)) {
    const passer = sim.players[sim.oneTwo.passerId]
    if (!passer.sentOff && passer.id !== carrierId && !overrides.has(passer.id)) {
      const pAtt = sim.toAttack(passer.pos, passer.teamIdx)
      let marker: PlayerSim | null = null
      let md = 6
      for (const o of sim.active(1 - passer.teamIdx)) {
        if (o.info.role === 'GK') continue
        const dd = dist(o.pos, passer.pos)
        if (dd < md) {
          md = dd
          marker = o
        }
      }
      const line = sim.offsideLine(passer.teamIdx)
      const x = Math.min(pAtt.x + 12, line - 1)
      let y = pAtt.y
      if (marker) {
        const mAtt = sim.toAttack(marker.pos, passer.teamIdx)
        // Markörün boş yanından geç (ondan uzağa açıl)
        y = pAtt.y + (pAtt.y >= mAtt.y ? 4.5 : -4.5)
      }
      y = Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, y))
      const target = sim.fromAttack({ x, y }, passer.teamIdx)
      overrides.set(passer.id, { target, sprint: dist(passer.pos, target) > 2 })
    }
  }

  // BİNDİRME (overlap): taşıyıcı kanatta ve hücum yarısındayken, aynı
  // kanattan gerideki bir bek dış koridordan öne fırlar — genişlik ve
  // sayısal fazlalık yaratır, taşıyıcıya boş bir dış çıkış sunar.
  if (carrierId >= 0 && possTeam >= 0) {
    const carrier = sim.players[carrierId]
    const cAtt = sim.toAttack(carrier.pos, carrier.teamIdx)
    if (cAtt.x > 4 && Math.abs(cAtt.y) > 16) {
      const flank = cAtt.y >= 0 ? 1 : -1
      let back: PlayerSim | null = null
      let bd = 18
      for (const m of sim.active(carrier.teamIdx)) {
        if (m.id === carrierId || m.info.role !== 'DF') continue
        if (overrides.has(m.id)) continue
        const mAtt = sim.toAttack(m.pos, carrier.teamIdx)
        if ((mAtt.y >= 0 ? 1 : -1) !== flank) continue // aynı kanat
        if (mAtt.x > cAtt.x - 1) continue // taşıyıcının gerisinde olmalı
        const dd = dist(m.pos, carrier.pos)
        if (dd < bd) {
          bd = dd
          back = m
        }
      }
      if (back) {
        const line = sim.offsideLine(carrier.teamIdx)
        const x = Math.min(cAtt.x + 8, line - 1)
        const y = flank * Math.min(HALF_WIDTH - 2, Math.abs(cAtt.y) + 5) // dıştan sar
        const target = sim.fromAttack({ x, y }, carrier.teamIdx)
        overrides.set(back.id, { target, sprint: dist(back.pos, target) > 3 })
      }
    }
  }

  // Son adam kuralı: savunma hattı en derine sarkan TOPSUZ rakip koşucuyu
  // takip eder. Topu süren oyuncu hesaba katılmaz — o geri kaçılarak değil,
  // önden çıkan görevliyle KARŞILANIR (kademe mantığı)
  let deepestThreat = 99
  if (defTeam >= 0) {
    for (const o of sim.active(1 - defTeam)) {
      if (o.info.role === 'GK' || o.id === carrierId) continue
      deepestThreat = Math.min(deepestThreat, sim.toAttack(o.pos, defTeam).x)
    }
  }

  // Hücumdaki takımın ofsayt çizgisi (topsuz hücumcular gerisinde kalır)
  const onsideLine = possTeam >= 0 ? sim.offsideLine(possTeam) : 99

  // Adam adama markaj: savunan DF/MF'ler bölgesindeki boştaki rakibi kale
  // tarafından tutar; görevliler hariç, rakip başına tek markajcı
  const markTargets = new Map<number, Vec2>()
  if (defTeam >= 0) {
    const marked = new Set<number>()
    const oppList = sim.active(1 - defTeam).filter((o) => o.id !== carrierId)
    for (const d of sim.active(defTeam)) {
      if (d.info.role !== 'DF' && d.info.role !== 'MF') continue
      if (overrides.has(d.id)) continue
      const zonal = targetPosition(sim.slotOf(d), sim.attackDir[d.teamIdx], bp, false)
      let best: PlayerSim | null = null
      let bestD = 12
      for (const o of oppList) {
        if (marked.has(o.id)) continue
        const dd = dist(o.pos, zonal)
        if (dd < bestD) {
          bestD = dd
          best = o
        }
      }
      if (best) {
        marked.add(best.id)
        // Pas hattını kapatan markaj: adamın top tarafında + hafif kale
        // tarafında dur (top ayağına gelmesin)
        const toBall = norm(sub(bp, best.pos))
        const goalSide = sim.fromAttack({ x: -0.8, y: 0 }, defTeam)
        let off = add(scale(toBall, 1.2), goalSide)
        // Çarpışma tabanı 2.0 m: bileşke ofset bunun altına düşerse
        // markajcı hedefe hiç varamaz (tık tık kekemelik) — tabanın
        // hemen dışına çek, yön aynı kalsın
        const offLen = Math.hypot(off.x, off.y)
        if (offLen < 2.2) {
          off = offLen < 1e-6 ? scale(toBall, 2.2) : scale(off, 2.2 / offLen)
        }
        let mt = add(best.pos, off)
        if (dist(mt, zonal) > 8) {
          mt = add(zonal, scale(norm(sub(mt, zonal)), 8))
        }
        markTargets.set(d.id, mt)
      }
    }
  }

  const ballVel = sim.ball.kind === 'rolling' ? sim.ball.vel : vec(0, 0)
  // Defanstan çıkış tespiti: topu kontrol eden takım kendi üçte birinde
  const ballAttPoss = possTeam >= 0 ? sim.toAttack(bp, possTeam) : null
  const buildUp = ballAttPoss !== null && ballAttPoss.x < -18

  // Kaleci atlayışı: reaksiyon süresi dolduysa şutun varış noktasına
  // sprint override eder — normal pozisyon takibinin önüne geçer
  if (
    sim.keeperDive &&
    sim.ball.kind === 'inFlight' &&
    sim.ball.flight === 'shot' &&
    sim.tick >= sim.keeperDive.readyTick
  ) {
    overrides.set(sim.keeperDive.keeperId, { target: sim.keeperDive.to, sprint: true })
  }

  for (const p of sim.active()) {
    let target: Vec2
    let sprint = false
    const ov = overrides.get(p.id)

    // Faulle yerde kalan oyuncu kalkana kadar hareket etmez
    if (p.id === sim.downedId && sim.tick < sim.downedUntil) {
      p.vel = vec(0, 0)
      continue
    }

    if (p.id === carrierId) {
      const dB = dist(p.pos, bp)
      if (dB > 1.0) {
        // Topunu kovala: vuruştan sonra topun duracağı noktaya koş
        target = add(bp, scale(ballVel, 0.3))
        sprint = true
      } else if (p.dribbleDir) {
        target = add(p.pos, scale(p.dribbleDir, 3))
      } else {
        // Alım anı: ani durmaz, momentumuyla süzülerek yavaşlar
        p.vel = scale(p.vel, Math.max(0, 1 - 2.8 * dt))
        p.pos = add(p.pos, scale(p.vel, dt))
        continue
      }
    } else if (ov) {
      target = ov.target
      sprint = ov.sprint
    } else if (markTargets.has(p.id)) {
      // Markajcı adamına yapışık kalır — son adam kuralı ona uygulanmaz
      target = markTargets.get(p.id) as Vec2
    } else {
      target = targetPosition(
        sim.slotOf(p),
        sim.attackDir[p.teamIdx],
        bp,
        possTeam === p.teamIdx,
        sim.effTactics[p.teamIdx],
      )

      // Hücumdaki oyuncu ofsayt çizgisinin gerisinde kalır (çizgi dansı)
      if (p.teamIdx === possTeam && p.id !== carrierId) {
        const attT = sim.toAttack(target, p.teamIdx)
        if (attT.x > onsideLine - 0.15) {
          target = sim.fromAttack({ x: onsideLine - 0.15, y: attT.y }, p.teamIdx)
        }
      }

      // Defanstan çıkış düzeni: sahayı büyüt. Stoperler ceza sahası
      // genişliğine açılır, bekler yüksek ve geniş çıkar, pivot topun
      // önünde ilk pas hattına iner, kanatlar geniş kalır — kısa pas
      // açıları doğar, pres kırılır.
      if (
        buildUp &&
        ballAttPoss &&
        p.teamIdx === possTeam &&
        p.id !== carrierId &&
        p.info.role !== 'GK' &&
        p.info.role !== 'FW'
      ) {
        const slot = sim.slotOf(p)
        let att = sim.toAttack(target, p.teamIdx)
        if (p.info.role === 'DF') {
          if (Math.abs(slot.width) >= 0.5) {
            // bek: yüksek ve geniş
            att = { x: Math.max(att.x, ballAttPoss.x + 10), y: Math.sign(slot.width) * 23 }
          } else {
            // stoper: genişliğe açıl, topla aynı hatta kal
            const side = slot.width !== 0 ? Math.sign(slot.width) : p.slotIdx % 2 ? 1 : -1
            att = { x: Math.min(att.x, ballAttPoss.x + 6), y: side * 14 }
          }
        } else if (Math.abs(slot.width) < 0.35) {
          // pivot / merkez orta saha: topun önünde kademeli pas hattı
          att = {
            x: ballAttPoss.x + 8 + Math.abs(slot.width) * 20,
            y: att.y * 0.4,
          }
        } else {
          // kanat orta saha: geniş kal, sahayı yay
          att = { x: att.x, y: Math.sign(slot.width) * Math.max(Math.abs(att.y), 22) }
        }
        target = sim.fromAttack(att, p.teamIdx)
      }

      // Son adam kuralı (yalnız bölge tutan DF'ler): hattın arkasında
      // koşucu bırakılmaz — en derin rakipten önde durulamaz
      if (p.teamIdx === defTeam && p.info.role === 'DF' && deepestThreat < -5) {
        const attT = sim.toAttack(target, p.teamIdx)
        const floor = Math.max(deepestThreat - 1, -HALF_LENGTH + 5)
        if (attT.x > floor) {
          target = sim.fromAttack({ x: floor, y: attT.y }, p.teamIdx)
        }
      }

      // Kademeli hat: toptan uzak kanattaki savunmacılar biraz derine
      // kademelenir — hat düz bir çizgi değil, çapraz bir merdiven olur
      if (p.teamIdx === defTeam && p.info.role === 'DF') {
        const latDist = Math.abs(target.y - bp.y)
        const drop = Math.min(3, Math.max(0, latDist - 8) * 0.15)
        if (drop > 0) {
          const attT = sim.toAttack(target, p.teamIdx)
          target = sim.fromAttack({ x: attT.x - drop, y: attT.y }, p.teamIdx)
        }
      }
    }

    // Üst üste binmeyi önleyen ayrışma (taşıyıcı ve kaleci hariç)
    if (p.id !== carrierId && p.info.role !== 'GK') {
      target = add(target, sim.separation(p))
    }

    // Enerji tasarrufu: pozisyon tutarken tempolu yürüyüş/hafif koşu;
    // yalnız hedefinden iyice kopan oyuncu tam koşar
    const far = !sprint && dist(p.pos, target) > 10
    // Taşıyıcı: topu kovalarken hızlı, ayakta oynarken kısık — vur-kaç
    // ritmi fizikten kendiliğinden doğar. Taşıyıcı çarpanı top mesafesiyle
    // SÜREKLİ geçer (0.6→0.92): vuruş döngüsünde hız zıplaması titremeydi.
    const carrierFactor = p.id === carrierId ? (sprint ? 0.92 : 0.6) : 1
    const wantSprint = sprint || far
    // Sprint rezervi tükendiyse tam sprint hızına ulaşılamaz (üst üste koşma)
    const cap = wantSprint ? sprintCap(p.sprintReserve) : 1
    const spd =
      maxSpeed(p.info.attributes) *
      energyFactor(p.energy) *
      (wantSprint ? 1 : 0.7) *
      carrierFactor *
      cap
    // Taşıyıcı çevikliği sabit (vur-kaç fazları arası 6↔14 sıçraması titremeydi);
    // yorgunlukla yine de düşer (yorgun oyuncu geç döner/hızlanır)
    // Çeviklik yorgunlukla düşer: yorgun oyuncu geç döner/hızlanır
    const agi = (sprint ? 14 : 6) * agilityFactor(p.energy)
    const moved = sim.movePlayer(p, target, spd, dt, agi)

    sim.updateStamina(p, moved, dt)
  }

  sim.resolveCollisions()
}
