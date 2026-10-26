import type { FaultMode } from './plant'

// Knowledge base. The cited excerpts are short paraphrases of two real public references, each with
// its page and link: NASA KSC Preferred Practices AT-8 and Woodard and Wolka (NSK), Texas A&M 2011.
// They support the qualitative symptoms and remedies only. The numeric signatures in `proto`, the
// part numbers, hours and repair steps are model parameters for this demo, not taken from those
// documents. In a plant this layer is built from the OEM manuals, the FMEA register and CMMS history.

export interface ModeKB {
  mode: FaultMode
  skill: 'bearing' | 'alignment' | 'lubrication' | 'balancing'
  hours: number
  proto: [number, number] // typical (vibration rise ratio, temperature rise above normal in deg C)
  action: string
  steps: string[]
  parts: { no: string; desc: string; qty: number }[]
  cite: { doc: string; section: string; text: string; url: string }[]
}

export const MODES: Record<FaultMode, ModeKB> = {
  'Bearing wear': {
    mode: 'Bearing wear',
    skill: 'bearing',
    hours: 4,
    proto: [1.5, 11],
    action: 'Replace drive-end and non-drive-end bearings and re-grease',
    steps: ['Lock out and tag out the asset', 'Remove coupling guard and decouple', 'Replace both bearings and seals', 'Re-grease to spec and refit', 'Run-up check and log vibration signature'],
    parts: [
      { no: 'BRG-6310-2RS', desc: 'Deep groove bearing set', qty: 2 },
      { no: 'SEAL-KIT-A', desc: 'Shaft seal kit', qty: 1 },
    ],
    cite: [
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 81, Vibration', text: 'As a bearing wears or becomes damaged, its vibration level rises, so current vibration is compared with the level recorded when the bearing was new.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 80, Preventive Maintenance Techniques', text: 'A change from baseline in noise, vibration, temperature or lubrication points to bearing deterioration and suggests prompt maintenance action.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
      { doc: 'NASA KSC Preferred Practices, Technique AT-8: Vibration Analysis of Rotating Ground Support Machinery', section: 'p. AT-49', text: 'Bearings in a machine train limit operating life and are usually the first to fail, so the first sign of trouble often shows in the bearing vibration signature, though the bearing is typically not the root cause.', url: 'https://extapps.ksc.nasa.gov/Reliability/Documents/Preferred_Practices/at8.pdf' },
    ],
  },
  'Shaft misalignment': {
    mode: 'Shaft misalignment',
    skill: 'alignment',
    hours: 3,
    proto: [1.1, 15],
    action: 'Laser-align the shaft and replace the coupling element if worn',
    steps: ['Lock out and tag out the asset', 'Check soft foot and base bolts', 'Laser align and record readings', 'Replace coupling element if worn', 'Run-up check'],
    parts: [
      { no: 'COUPL-ELM-30', desc: 'Coupling elastomer element', qty: 1 },
      { no: 'ALN-SHIM-KIT', desc: 'Alignment shim kit', qty: 1 },
    ],
    cite: [
      { doc: 'NASA KSC Preferred Practices, Technique AT-8: Vibration Analysis of Rotating Ground Support Machinery', section: 'p. AT-48', text: 'Imbalance and misalignment together account for roughly 80% of machinery problems and can lead to premature bearing, coupling, shaft seal and gear wear.', url: 'https://extapps.ksc.nasa.gov/Reliability/Documents/Preferred_Practices/at8.pdf' },
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 81, Temperature', text: 'A drift from steady-state bearing temperature can come from coupling misalignment, among other causes such as lubrication starvation and abnormal loading.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 88, Mounting and Alignment', text: 'Aligning directly coupled shafts prevents eccentric rotation, and misalignment in roller bearings causes roller edge loading.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
    ],
  },
  'Lubrication starvation': {
    mode: 'Lubrication starvation',
    skill: 'lubrication',
    hours: 2,
    proto: [0.35, 26],
    action: 'Flush and re-lubricate, inspect seals for leaks',
    steps: ['Lock out and tag out the asset', 'Purge old lubricant', 'Inspect seals and lines for leaks', 'Refill to level and verify flow', 'Run-up check on temperature'],
    parts: [
      { no: 'LUB-GRS-5K', desc: 'Lubricant refill kit', qty: 1 },
      { no: 'SEAL-KIT-A', desc: 'Shaft seal kit', qty: 1 },
    ],
    cite: [
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 81, Temperature', text: 'Bearing temperature rise comes from friction, and a drift from steady state can be caused by lubrication starvation, excessive lubrication, the wrong lubricant or contamination.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 82, Table 2', text: 'Insufficient or improper lubricant shows up as noise and abnormal temperature rise; the remedy is to replenish it or choose a better lubricant.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'pp. 84-86, Lubrication', text: 'Too little lubricant discolours bearings from heat, too much can cause skidding, and the grease replenishment interval should be halved for each 15 deg C of bearing temperature above 70 deg C.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
    ],
  },
  'Rotor imbalance': {
    mode: 'Rotor imbalance',
    skill: 'balancing',
    hours: 3,
    proto: [1.25, 3.5],
    action: 'Clean the rotor and rebalance on site',
    steps: ['Lock out and tag out the asset', 'Inspect rotor for build-up or damage', 'Clean and rebalance with trial weights', 'Verify vibration at 1x running speed', 'Run-up check'],
    parts: [{ no: 'BAL-WT-KIT', desc: 'Balancing weight kit', qty: 1 }],
    cite: [
      { doc: 'NASA KSC Preferred Practices, Technique AT-8: Vibration Analysis of Rotating Ground Support Machinery', section: 'p. AT-48', text: 'Imbalance and misalignment together account for roughly 80% of machinery problems, and each failure mode has distinct vibration frequency components that can be isolated.', url: 'https://extapps.ksc.nasa.gov/Reliability/Documents/Preferred_Practices/at8.pdf' },
      { doc: 'Woodard and Wolka (NSK), Bearing Maintenance Practices to Ensure Maximum Life, 27th Intl Pump Users Symposium, Texas A&M, 2011', section: 'p. 80-81, Vibration', text: 'Common problems such as imbalance, play and misalignment are best evaluated by measuring vibration displacement or velocity with accelerometers.', url: 'https://oaktrust.library.tamu.edu/bitstream/1969.1/162611/1/Bearing%20Maintenance%20Practices%20to%20Ensure%20Maximum%20Life.pdf' },
      { doc: 'NASA KSC Preferred Practices, Technique AT-8: Vibration Analysis of Rotating Ground Support Machinery', section: 'p. AT-49', text: 'Vibration is trended against an initial baseline, with weekly readings for four weeks on new or refurbished equipment, so a rising level is read as a change in operating dynamics.', url: 'https://extapps.ksc.nasa.gov/Reliability/Documents/Preferred_Practices/at8.pdf' },
    ],
  },
}

export interface Tech {
  id: string
  name: string
  skills: string[]
  shift: 'A' | 'B' | 'C'
}
export const TECHS: Tech[] = [
  { id: 'T1', name: 'R. Menon', skills: ['bearing', 'alignment'], shift: 'A' },
  { id: 'T2', name: 'S. Iyer', skills: ['lubrication', 'balancing'], shift: 'A' },
  { id: 'T3', name: 'K. Rao', skills: ['bearing', 'lubrication'], shift: 'B' },
  { id: 'T4', name: 'P. Nair', skills: ['alignment', 'balancing'], shift: 'B' },
  { id: 'T5', name: 'D. Shah', skills: ['bearing', 'balancing'], shift: 'C' },
  { id: 'T6', name: 'A. Khan', skills: ['alignment', 'lubrication'], shift: 'C' },
]
export const SHIFT_HOURS: Record<string, [number, number]> = { A: [6, 14], B: [14, 22], C: [22, 6] }

export function onShift(t: Tech, hod: number) {
  const [s, e] = SHIFT_HOURS[t.shift]
  return s < e ? hod >= s && hod < e : hod >= s || hod < e
}

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
// Mock SAP stock: deterministic per part and asset type, so the demo is repeatable.
export function partStock(no: string, assetType: string) {
  const h = hash(no + assetType)
  const qty = h % 4
  return { qty, inStock: qty > 0, leadDays: 2 + ((h >>> 3) % 5) }
}
