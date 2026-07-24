import type { PlayerAttributes, PlayerInfo, Role, TeamInfo } from '../engine/types'

// Kurgusal iki kadro. Gerçek kulüp/oyuncu adı kullanılmaz.
// Nitelikler FM tarzı 1–20; roller pozisyona göre eğimli.

function p(
  name: string,
  number: number,
  role: Role,
  attrs: Partial<PlayerAttributes> & { base: number },
): PlayerInfo {
  const b = attrs.base
  return {
    name,
    number,
    role,
    attributes: {
      pace: attrs.pace ?? b,
      passing: attrs.passing ?? b,
      shooting: attrs.shooting ?? b,
      dribbling: attrs.dribbling ?? b,
      tackling: attrs.tackling ?? b,
      positioning: attrs.positioning ?? b,
      goalkeeping: attrs.goalkeeping ?? 3,
      stamina: attrs.stamina ?? b,
      height: attrs.height ?? b,
      strength: attrs.strength ?? b,
      heading: attrs.heading ?? b,
      composure: attrs.composure ?? b,
    },
  }
}

export const KIZILKAYA: TeamInfo = {
  name: 'Kızılkaya SK',
  shortName: 'KIZ',
  color: '#c0202a',
  gkColor: '#e6c619',
  formation: '4-4-2',
  starters: [
    p('Demirok', 1, 'GK', { base: 8, goalkeeping: 15, positioning: 14, pace: 8 }),
    p('Sarpkan', 2, 'DF', { base: 12, tackling: 15, positioning: 14, shooting: 6 }),
    p('Koçero', 4, 'DF', { base: 12, tackling: 16, positioning: 15, pace: 10, shooting: 5, height: 16, strength: 15, heading: 15 }),
    p('Baltacı', 5, 'DF', { base: 11, tackling: 15, positioning: 14, shooting: 5, height: 15, strength: 14, heading: 13 }),
    p('Yalınay', 3, 'DF', { base: 12, tackling: 14, pace: 14, shooting: 6 }),
    p('Kavruk', 7, 'MF', { base: 13, pace: 15, dribbling: 14, passing: 13 }),
    p('Ozansü', 8, 'MF', { base: 13, passing: 16, positioning: 14, shooting: 11 }),
    p('Tekeli', 6, 'MF', { base: 12, tackling: 14, passing: 13, shooting: 9 }),
    p('Aksungur', 11, 'MF', { base: 13, pace: 16, dribbling: 15, passing: 12, height: 9, strength: 9 }),
    p('Bozdoğan', 9, 'FW', { base: 13, shooting: 16, pace: 14, dribbling: 13, tackling: 6, composure: 16, heading: 12 }),
    p('Çelenk', 10, 'FW', { base: 13, shooting: 15, passing: 14, dribbling: 14, tackling: 6, composure: 15 }),
  ],
  subs: [
    p('Kürkçü', 12, 'GK', { base: 7, goalkeeping: 13 }),
    p('Sazak', 13, 'DF', { base: 10, tackling: 13 }),
    p('Ilgaz', 14, 'MF', { base: 11, passing: 13 }),
    p('Doruk', 15, 'MF', { base: 11, pace: 13 }),
    p('Serhat', 16, 'FW', { base: 11, shooting: 13 }),
  ],
}

export const MAVIDERE: TeamInfo = {
  name: 'Mavidere FK',
  shortName: 'MAV',
  color: '#1c56b0',
  gkColor: '#2ab5a0',
  formation: '4-3-3',
  starters: [
    p('Akkuş', 1, 'GK', { base: 8, goalkeeping: 14, positioning: 13, pace: 8 }),
    p('Turaç', 2, 'DF', { base: 11, tackling: 14, positioning: 13, shooting: 5 }),
    p('Ertaş', 4, 'DF', { base: 11, tackling: 15, positioning: 14, pace: 9, shooting: 5, height: 15, strength: 15, heading: 14 }),
    p('Kayra', 5, 'DF', { base: 11, tackling: 14, positioning: 13, shooting: 5, height: 14, strength: 13, heading: 12 }),
    p('Günalp', 3, 'DF', { base: 11, tackling: 13, pace: 13, shooting: 6 }),
    p('Savaştı', 6, 'MF', { base: 12, tackling: 13, passing: 14, positioning: 13 }),
    p('Denizhan', 8, 'MF', { base: 12, passing: 15, dribbling: 13, shooting: 10 }),
    p('Yamaner', 10, 'MF', { base: 12, passing: 14, shooting: 12, dribbling: 13 }),
    p('Rüzgar', 7, 'FW', { base: 12, pace: 16, dribbling: 15, shooting: 12, tackling: 5, height: 9, strength: 9 }),
    p('Umutlu', 9, 'FW', { base: 12, shooting: 15, pace: 13, positioning: 13, tackling: 5, height: 16, strength: 15, heading: 16, composure: 14 }),
    p('Serinsu', 11, 'FW', { base: 12, pace: 15, dribbling: 14, shooting: 12, tackling: 5, height: 10, strength: 10 }),
  ],
  subs: [
    p('Balkır', 12, 'GK', { base: 7, goalkeeping: 12 }),
    p('Tanju', 13, 'DF', { base: 10, tackling: 12 }),
    p('Evren', 14, 'MF', { base: 10, passing: 12 }),
    p('Onat', 15, 'FW', { base: 10, shooting: 12 }),
    p('Poyraz', 16, 'FW', { base: 10, pace: 13 }),
  ],
}
