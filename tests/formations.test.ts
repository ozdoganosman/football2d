import { describe, expect, it } from 'vitest'
import { FORMATION_IDS, FORMATIONS } from '../src/engine/formations'
import { homePositionAtt } from '../src/engine/positioning'
import { HALF_LENGTH, HALF_WIDTH } from '../src/engine/constants'

describe('formasyonlar', () => {
  it('her formasyonda 11 slot ve ilk slot kaleci', () => {
    for (const id of FORMATION_IDS) {
      const slots = FORMATIONS[id]
      expect(slots).toHaveLength(11)
      expect(slots[0].role).toBe('GK')
      expect(slots.filter((s) => s.role === 'GK')).toHaveLength(1)
    }
  })

  it('slot değerleri geçerli aralıkta', () => {
    for (const id of FORMATION_IDS) {
      for (const s of FORMATIONS[id]) {
        expect(s.depth).toBeGreaterThan(0)
        expect(s.depth).toBeLessThan(1)
        expect(Math.abs(s.width)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('ev pozisyonları saha içinde', () => {
    for (const id of FORMATION_IDS) {
      for (const s of FORMATIONS[id]) {
        const p = homePositionAtt(s)
        expect(Math.abs(p.x)).toBeLessThanOrEqual(HALF_LENGTH)
        expect(Math.abs(p.y)).toBeLessThanOrEqual(HALF_WIDTH)
      }
    }
  })
})
