import type { FormationId, FormationSlot } from './types'

// depth: 0 = kendi kale çizgisi, 1 = rakip kale çizgisi; width: -1 (sol) .. 1 (sağ)
// Slot 0 daima kaleci. Depth değerleri topsuz durumdaki temel bloktur;
// topa/hücuma göre kaydırma positioning.ts'te yapılır.
export const FORMATIONS: Record<FormationId, FormationSlot[]> = {
  '4-4-2': [
    { depth: 0.04, width: 0, role: 'GK' },
    { depth: 0.22, width: -0.72, role: 'DF' },
    { depth: 0.18, width: -0.26, role: 'DF' },
    { depth: 0.18, width: 0.26, role: 'DF' },
    { depth: 0.22, width: 0.72, role: 'DF' },
    { depth: 0.5, width: -0.76, role: 'MF' },
    { depth: 0.4, width: -0.2, role: 'MF' },
    { depth: 0.4, width: 0.2, role: 'MF' },
    { depth: 0.5, width: 0.76, role: 'MF' },
    { depth: 0.68, width: -0.18, role: 'FW' },
    { depth: 0.68, width: 0.18, role: 'FW' },
  ],
  '4-3-3': [
    { depth: 0.04, width: 0, role: 'GK' },
    { depth: 0.22, width: -0.72, role: 'DF' },
    { depth: 0.18, width: -0.26, role: 'DF' },
    { depth: 0.18, width: 0.26, role: 'DF' },
    { depth: 0.22, width: 0.72, role: 'DF' },
    { depth: 0.38, width: 0, role: 'MF' },
    { depth: 0.46, width: -0.34, role: 'MF' },
    { depth: 0.46, width: 0.34, role: 'MF' },
    { depth: 0.62, width: -0.58, role: 'FW' },
    { depth: 0.7, width: 0, role: 'FW' },
    { depth: 0.62, width: 0.58, role: 'FW' },
  ],
  '4-2-3-1': [
    { depth: 0.04, width: 0, role: 'GK' },
    { depth: 0.22, width: -0.72, role: 'DF' },
    { depth: 0.18, width: -0.26, role: 'DF' },
    { depth: 0.18, width: 0.26, role: 'DF' },
    { depth: 0.22, width: 0.72, role: 'DF' },
    { depth: 0.36, width: -0.2, role: 'MF' },
    { depth: 0.36, width: 0.2, role: 'MF' },
    { depth: 0.52, width: -0.6, role: 'MF' },
    { depth: 0.5, width: 0, role: 'MF' },
    { depth: 0.52, width: 0.6, role: 'MF' },
    { depth: 0.68, width: 0, role: 'FW' },
  ],
  '3-5-2': [
    { depth: 0.04, width: 0, role: 'GK' },
    { depth: 0.19, width: -0.38, role: 'DF' },
    { depth: 0.16, width: 0, role: 'DF' },
    { depth: 0.19, width: 0.38, role: 'DF' },
    { depth: 0.38, width: -0.85, role: 'MF' },
    { depth: 0.44, width: -0.28, role: 'MF' },
    { depth: 0.4, width: 0, role: 'MF' },
    { depth: 0.44, width: 0.28, role: 'MF' },
    { depth: 0.38, width: 0.85, role: 'MF' },
    { depth: 0.68, width: -0.18, role: 'FW' },
    { depth: 0.68, width: 0.18, role: 'FW' },
  ],
}

export const FORMATION_IDS: FormationId[] = ['4-4-2', '4-3-3', '4-2-3-1', '3-5-2']
