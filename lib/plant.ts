import { mulberry32, makeGauss } from './rng'
import { IMS } from './imsData'

export const HOURS = 720 // 30 days, hourly samples
export const LEARN_H = 168 // first 7 days are a shadow-mode learning period: baselines build, no verdicts
export const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0) // Tue 1 Sep 2026, plant time
export const VIB_ALARM = 4.5 // mm/s, the legacy fixed threshold
export const TEMP_ALARM = 82 // deg C, the legacy fixed threshold

export type AssetType = 'Motor' | 'Gearbox' | 'Pump' | 'Compressor' | 'Conveyor drive'
export type FaultMode = 'Bearing wear' | 'Shaft misalignment' | 'Lubrication starvation' | 'Rotor imbalance'

export interface Line {
  id: string
  name: string
  windowStart: number // hour of day when the daily planned maintenance window opens
  windowLen: number
}
export interface Asset {
  id: string
  name: string
  line: string
  type: AssetType
  vibBase: number
  tempRise: number
  startupSens: number
}
export interface Series {
  vib: number[]
  temp: number[]
  load: number[]
  running: boolean[]
  startup: boolean[]
}
export interface Fault {
  id: string
  assetId: string
  mode: FaultMode
  onset: number
  failAt: number
  vibGain: number
  tempGain: number
  downtimeHrs: number
  curve?: number[] // real IMS vibration RMS ratio (vs healthy baseline), oldest to newest, for bearing faults
  source?: string // which real run-to-failure bearing the curve comes from
}
export interface Plant {
  lines: Line[]
  assets: Asset[]
  series: Record<string, Series>
  ambient: number[]
  faults: Fault[]
  repairs: Record<string, number> // hour the last work order closed per asset (CMMS history)
}

export const LINES: Line[] = [
  { id: 'L1', name: 'Line 1 Crankshaft machining', windowStart: 13, windowLen: 2 },
  { id: 'L2', name: 'Line 2 Gear assembly', windowStart: 21, windowLen: 2 },
  { id: 'L3', name: 'Line 3 Housing casting', windowStart: 5, windowLen: 2 },
]

const TYPES: AssetType[] = ['Motor', 'Gearbox', 'Pump', 'Compressor', 'Conveyor drive']
const HEAT_DAYS = new Set([12, 13, 14, 20, 21])

export function isSunday(h: number) {
  return Math.floor(h / 24) % 7 === 5
}
export function isStopped(line: Line, h: number) {
  if (isSunday(h)) return true
  const hod = h % 24
  return hod >= line.windowStart && hod < line.windowStart + line.windowLen
}

const RATIO_CAP = 6 // keep one extreme bearing from dominating the plant

function curveAt(curve: number[], x: number) {
  const pos = Math.max(0, Math.min(1, x)) * (curve.length - 1)
  const i = Math.floor(pos)
  const j = Math.min(curve.length - 1, i + 1)
  return curve[i] + (curve[j] - curve[i]) * (pos - i)
}

// Vibration gain above healthy (0 = healthy). For bearing faults this is the real IMS ratio minus 1,
// so vibration is multiplied by the measured ratio. Other fault modes use a simulated power-law rise.
export function faultGain(f: Fault, h: number) {
  if (h < f.onset || h >= f.failAt) return 0
  const x = (h - f.onset) / (f.failAt - f.onset)
  if (f.curve) return Math.max(0, Math.min(RATIO_CAP, curveAt(f.curve, x)) - 1)
  return Math.pow(x, 1.6)
}
// Temperature has no IMS counterpart, so it follows the vibration gain through a simulated coupling.
export function faultTempGain(f: Fault, h: number) {
  const g = faultGain(f, h)
  return f.curve ? Math.min(1, g / 2) : g
}

let cached: Plant | null = null
export function getPlant(): Plant {
  if (!cached) cached = buildPlant()
  return cached
}

function buildPlant(): Plant {
  const rnd = mulberry32(20261022)
  const gauss = makeGauss(rnd)

  const assets: Asset[] = []
  LINES.forEach((ln, li) => {
    const n = li === 2 ? 14 : 13
    for (let k = 0; k < n; k++) {
      const type = TYPES[(k + li) % TYPES.length]
      assets.push({
        id: `${ln.id}-${String(k + 1).padStart(2, '0')}`,
        name: `${type} ${String(k + 1).padStart(2, '0')}`,
        line: ln.id,
        type,
        vibBase: 2.4 + rnd() * 1.0,
        tempRise: 38 + rnd() * 10,
        startupSens: 0.3 + rnd() * 0.9,
      })
    }
  })

  // ambient temperature, with a few heat-wave days
  const ambient: number[] = []
  for (let h = 0; h < HOURS; h++) {
    const day = Math.floor(h / 24)
    const hod = h % 24
    ambient.push(30 + 4 * Math.sin((2 * Math.PI * (hod - 9)) / 24) + (HEAT_DAYS.has(day) ? 5 : 0) + 0.5 * gauss())
  }

  // shared line load (AR(1) noise on a shift pattern)
  const lineLoad: Record<string, number[]> = {}
  for (const ln of LINES) {
    const arr: number[] = []
    let x = 0
    for (let h = 0; h < HOURS; h++) {
      x = 0.9 * x + 0.05 * gauss()
      const shift = Math.floor((h % 24) / 8)
      const base = [0.72, 0.9, 0.66][shift]
      arr.push(Math.max(0.4, Math.min(1, base + x)))
    }
    lineLoad[ln.id] = arr
  }

  // seeded faults on 10 distinct assets
  const idxs = assets.map((_, i) => i)
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[idxs[i], idxs[j]] = [idxs[j], idxs[i]]
  }
  const modes: FaultMode[] = ['Bearing wear', 'Shaft misalignment', 'Lubrication starvation', 'Rotor imbalance', 'Bearing wear']
  let bearingNo = 0
  const faults: Fault[] = idxs.slice(0, 10).map((ai, k) => {
    const mode = modes[k % modes.length]
    const failAt = 420 + Math.floor(rnd() * 270)
    const dur = 144 + Math.floor(rnd() * 72)
    const gains: Record<FaultMode, [number, number]> = {
      'Bearing wear': [1.35 + rnd() * 0.3, 9.5 + rnd() * 3],
      'Shaft misalignment': [1.0 + rnd() * 0.2, 15 + rnd() * 3],
      'Lubrication starvation': [0.3 + rnd() * 0.1, 23 + rnd() * 6],
      'Rotor imbalance': [1.1 + rnd() * 0.3, 2 + rnd() * 2],
    }
    const real = mode === 'Bearing wear' ? IMS.curves[bearingNo++ % IMS.curves.length] : undefined
    return {
      id: `F${k + 1}`,
      assetId: assets[ai].id,
      mode,
      onset: failAt - dur,
      failAt,
      vibGain: real ? 1 : gains[mode][0],
      curve: real ? (real.ratio as readonly number[]).slice() : undefined,
      source: real ? real.source : undefined,
      tempGain: gains[mode][1],
      downtimeHrs: 6 + Math.floor(rnd() * 13),
    }
  })

  const NOISE = IMS.noise as readonly number[]
  const nrnd = mulberry32(77)
  const series: Record<string, Series> = {}
  for (const a of assets) {
    const ln = LINES.find((l) => l.id === a.line)!
    const f = faults.find((x) => x.assetId === a.id)
    const s: Series = { vib: [], temp: [], load: [], running: [], startup: [] }
    const mult = 0.9 + rnd() * 0.2
    const noiseOff = Math.floor(nrnd() * NOISE.length)
    for (let h = 0; h < HOURS; h++) {
      let running = !isStopped(ln, h)
      const down = f && h >= f.failAt && h < f.failAt + f.downtimeHrs
      if (down) running = false
      const prevStopped = h > 0 && (isStopped(ln, h - 1) || (f !== undefined && h - 1 >= f.failAt && h - 1 < f.failAt + f.downtimeHrs))
      const prev2Stopped = h > 1 && (isStopped(ln, h - 2) || (f !== undefined && h - 2 >= f.failAt && h - 2 < f.failAt + f.downtimeHrs))
      const startup = running && (prevStopped || prev2Stopped)
      const load = running ? Math.max(0.35, Math.min(1, lineLoad[ln.id][h] * mult)) : 0
      let vib: number
      let temp: number
      if (running) {
        vib = a.vibBase * (0.55 + 0.55 * load)
        if (startup) vib *= 1 + 0.9 * a.startupSens * (prevStopped ? 1 : 0.55)
        vib *= 1 + 0.07 * gauss() // plant process variance (load, ambient): not present in the IMS test rig
        vib *= 1 + NOISE[(noiseOff + h) % NOISE.length] // real healthy-bearing measurement noise from IMS
        if (rnd() < 0.0005) vib *= 2 + rnd() * 1.5
        temp = ambient[h] + a.tempRise * (0.4 + 0.6 * load) + 0.8 * gauss()
        if (f) {
          vib *= 1 + f.vibGain * faultGain(f, h)
          temp += f.tempGain * faultTempGain(f, h)
        }
      } else {
        vib = Math.abs(0.15 + 0.03 * gauss())
        temp = ambient[h] + 3 + 0.5 * gauss()
      }
      s.vib.push(+vib.toFixed(3))
      s.temp.push(+temp.toFixed(2))
      s.load.push(+load.toFixed(3))
      s.running.push(running)
      s.startup.push(startup)
    }
    series[a.id] = s
  }

  const repairs: Record<string, number> = {}
  for (const f of faults) repairs[f.assetId] = f.failAt + f.downtimeHrs
  return { lines: LINES, assets, series, ambient, faults, repairs }
}
