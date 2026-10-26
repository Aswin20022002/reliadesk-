import { Plant, Asset, FaultMode, LINES, VIB_ALARM, TEMP_ALARM, isStopped, isSunday } from './plant'
import { MODES, TECHS, onShift, partStock } from './kb'
import { fmt, iso } from './time'

export type Verdict = 'Act now' | 'Plan in window' | 'Watch' | 'Suppress'
export type Trigger = 'vibration' | 'temperature' | 'both' | 'drift'

export interface Candidate {
  id: string
  assetId: string
  hour: number
  trigger: Trigger
  truth: { real: boolean; faultId?: string; mode?: FaultMode }
}
export type OutcomeLabel = 'confirmed' | 'no_fault' | 'other'
export interface Outcomes {
  [alertId: string]: { assetId: string; label: OutcomeLabel }
}

// ---------- shared math ----------
const med = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mad = (a: number[], m: number) => med(a.map((x) => Math.abs(x - m))) * 1.4826
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const bin = (l: number) => (l < 0.72 ? 0 : l < 0.84 ? 1 : 2)

// ---------- Signal agent: per-asset, load-aware baselines ----------
export interface Features {
  ok: boolean
  note?: string
  loadNow: number
  vibNow: number
  tempNow: number
  expVib: number
  expDelta: number
  rvMean: number // mean vibration rise vs normal for the load, last 24 clean running hours
  rtMean: number // mean temperature rise above (ambient + normal) in deg C
  zV: number
  zT: number
  persistence: number
  trendV: number
  trendT: number
  sdV: number
  sdT: number
  n: number
  history: number
}

const EMPTY: Features = {
  ok: false, loadNow: 0, vibNow: 0, tempNow: 0, expVib: 0, expDelta: 0, rvMean: 0, rtMean: 0, zV: 0, zT: 0,
  persistence: 0, trendV: 0, trendT: 0, sdV: 0.07, sdT: 1, n: 0, history: 0,
}

export function computeFeatures(p: Plant, a: Asset, h: number, wide = false): Features {
  const s = p.series[a.id]
  let lo = Math.max(0, h - 336)
  // a closed work order resets the asset's baseline: only post-repair data is trusted
  const rep = p.repairs[a.id]
  if (rep !== undefined && rep <= h) lo = Math.max(lo, rep)
  const hi = Math.max(lo, h - (wide ? 48 : 96))
  const V: number[][] = [[], [], []]
  const D: number[][] = [[], [], []]
  const allV: number[] = []
  const allD: number[] = []
  for (let t = lo; t < hi; t++) {
    if (!s.running[t] || s.startup[t]) continue
    const b = bin(s.load[t])
    const d = s.temp[t] - p.ambient[t]
    V[b].push(s.vib[t])
    D[b].push(d)
    allV.push(s.vib[t])
    allD.push(d)
  }
  const minN = wide ? 24 : 48
  if (allV.length < minN) return { ...EMPTY, note: `Only ${allV.length} clean running samples of history`, history: allV.length }
  const mv = med(allV)
  const md = med(allD)
  const expV = [0, 1, 2].map((b) => (V[b].length >= 24 ? med(V[b]) : mv))
  const expD = [0, 1, 2].map((b) => (D[b].length >= 24 ? med(D[b]) : md))
  const rvs: number[] = []
  const rts: number[] = []
  for (let t = lo; t < hi; t++) {
    if (!s.running[t] || s.startup[t]) continue
    const b = bin(s.load[t])
    rvs.push(s.vib[t] / expV[b] - 1)
    rts.push(s.temp[t] - p.ambient[t] - expD[b])
  }
  const sdV = Math.max(0.03, mad(rvs, med(rvs)))
  const sdT = Math.max(0.4, mad(rts, med(rts)))

  const collect = (from: number, count: number) => {
    const rv: number[] = []
    const rt: number[] = []
    let t = from
    while (t >= lo && rv.length < count && from - t < 120) {
      if (s.running[t] && !s.startup[t]) {
        const b = bin(s.load[t])
        rv.push(s.vib[t] / expV[b] - 1)
        rt.push(s.temp[t] - p.ambient[t] - expD[b])
      }
      t--
    }
    return { rv, rt, end: t }
  }
  const w1 = collect(h, 24)
  const w2 = collect(w1.end, 24)
  const n = w1.rv.length
  const rvMean = mean(w1.rv)
  const rtMean = mean(w1.rt)
  const zV = n >= 6 ? rvMean / (sdV / Math.sqrt(n)) : 0
  const zT = n >= 6 ? rtMean / (sdT / Math.sqrt(n)) : 0
  const last = Math.min(6, n)
  let hit = 0
  for (let i = 0; i < last; i++) if (w1.rv[i] / sdV > 3 || w1.rt[i] / sdT > 3) hit++
  const persistence = last ? hit / last : 0
  const trendV = w2.rv.length >= 6 ? rvMean - mean(w2.rv) : 0
  const trendT = w2.rt.length >= 6 ? rtMean - mean(w2.rt) : 0
  const b = bin(s.load[h])
  return {
    ok: true, loadNow: s.load[h], vibNow: s.vib[h], tempNow: s.temp[h], expVib: expV[b], expDelta: expD[b],
    rvMean, rtMean, zV, zT, persistence, trendV, trendT, sdV, sdT, n, history: allV.length,
  }
}

// ---------- Context agent ----------
export interface Context {
  line: string
  lineName: string
  loadPct: number
  ambient: number
  startup: boolean
  lineStopped: boolean
  nextWindow: string
}
export function contextFor(p: Plant, a: Asset, h: number): Context {
  const s = p.series[a.id]
  const ln = LINES.find((l) => l.id === a.line)!
  const startup = s.startup[h] || (h > 0 && s.startup[h - 1])
  let nw = h
  while (nw < h + 48 && !(isStopped(ln, nw) && !isStopped(ln, nw - 1))) nw++
  return {
    line: ln.id, lineName: ln.name, loadPct: Math.round(s.load[h] * 100), ambient: p.ambient[h], startup,
    lineStopped: isStopped(ln, h), nextWindow: fmt(nw),
  }
}

// ---------- Adjudicator ----------
export function assetAdj(outcomes: Outcomes, assetId: string) {
  let c = 0
  let n = 0
  for (const o of Object.values(outcomes)) {
    if (o.assetId !== assetId) continue
    if (o.label === 'confirmed') c++
    if (o.label === 'no_fault') n++
  }
  return Math.max(-1, Math.min(2, 0.5 * n - 0.5 * c))
}

export interface Adjudication {
  verdict: Verdict
  confidence: number
  reason: string
  needsHuman: boolean
  evidence: string[]
  threshold: number
  adj: number
}

export function adjudicate(f: Features, c: Candidate, ctx: Context, adj: number): Adjudication {
  const thr = 4 + adj
  if (!f.ok) {
    return {
      verdict: 'Watch', confidence: 0.3, needsHuman: true, threshold: thr, adj,
      reason: 'Not enough clean history for a trustworthy baseline, so this fails open to a human.',
      evidence: [f.note || 'Insufficient history'],
    }
  }
  const sustainedV = f.rvMean >= 0.08 && f.zV >= thr
  const sustainedT = f.rtMean >= 3.5 && f.zT >= thr
  const sustained = sustainedV || sustainedT
  const borderline = (f.rvMean >= 0.04 && f.zV >= 3) || (f.rtMean >= 2 && f.zT >= 3)
  const staticNow = f.vibNow > VIB_ALARM || f.tempNow > TEMP_ALARM
  const evidence: string[] = []
  evidence.push(`Vibration is ${(f.rvMean * 100).toFixed(0)}% ${f.rvMean >= 0 ? 'above' : 'below'} this asset's normal at ${ctx.loadPct}% load (z = ${f.zV.toFixed(1)}, ${f.n} clean hours)`)
  evidence.push(`Temperature is ${f.rtMean >= 0 ? '+' : ''}${f.rtMean.toFixed(1)} C versus normal for this load and ambient (z = ${f.zT.toFixed(1)})`)
  evidence.push(`Trend versus the previous day: vibration ${f.trendV >= 0 ? '+' : ''}${(f.trendV * 100).toFixed(0)} points, temperature ${f.trendT >= 0 ? '+' : ''}${f.trendT.toFixed(1)} C`)
  evidence.push(`${Math.round(f.persistence * 100)}% of the latest clean samples are abnormal`)
  if (ctx.startup) evidence.push('The asset restarted in the last two hours, so start-up transients apply')
  if (ctx.ambient >= 36) evidence.push(`Ambient is ${ctx.ambient.toFixed(0)} C, which lifts temperatures plant-wide`)
  if (adj !== 0) evidence.push(`Alert threshold for this asset adjusted by ${adj > 0 ? '+' : ''}${adj.toFixed(1)} z from technician outcomes`)

  if (sustained && f.history < 150) {
    return {
      verdict: 'Watch', confidence: 0.45, needsHuman: true, threshold: thr, adj, evidence,
      reason: `Baseline is still maturing (${f.history} of 150 clean hours needed), so this fails open to a human instead of issuing a verdict.`,
    }
  }
  if (sustained) {
    const act = f.rvMean >= 0.35 || f.rtMean >= 12 || staticNow || f.trendV >= 0.1 || f.trendT >= 3
    const zmax = Math.max(sustainedV ? f.zV : 0, sustainedT ? f.zT : 0)
    const conf = Math.max(0.55, Math.min(0.97, 0.55 + 0.04 * zmax))
    return {
      verdict: act ? 'Act now' : 'Plan in window', confidence: conf, needsHuman: conf < 0.6, threshold: thr, adj, evidence,
      reason: act
        ? 'Sustained and growing deviation from this asset\'s own baseline. Repair as soon as parts and a technician allow.'
        : 'Sustained deviation from this asset\'s baseline that is still modest. Repair in the next production window.',
    }
  }
  if (borderline) {
    return {
      verdict: 'Watch', confidence: 0.6, needsHuman: false, threshold: thr, adj, evidence,
      reason: 'Small but real shift from baseline. Keep watching and re-check automatically in 6 hours.',
    }
  }
  const zmax = Math.max(f.zV, f.zT, 0)
  const conf = Math.max(0.5, Math.min(0.97, 0.97 - 0.07 * zmax))
  let reason = 'Within the load-adjusted baseline for this asset.'
  if (ctx.startup) reason = 'Start-up transient: readings settle to normal once the asset is warm, and the prior day was clean.'
  else if (c.trigger === 'temperature' && ctx.ambient >= 36) reason = 'Ambient heat: temperature above ambient is normal for this load.'
  else if (f.persistence < 0.34) reason = `Isolated spike: only ${Math.round(f.persistence * 100)}% of recent clean samples are abnormal.`
  if (conf < 0.7) {
    return { verdict: 'Watch', confidence: conf, needsHuman: true, threshold: thr, adj, evidence, reason: 'Suppression confidence is below 0.7, so this fails open to a human.' }
  }
  return { verdict: 'Suppress', confidence: conf, needsHuman: false, threshold: thr, adj, evidence, reason }
}

// ---------- Diagnosis agent ----------
export interface Diagnosis {
  mode: FaultMode
  confidence: number
  alt: FaultMode
  altConfidence: number
  action: string
  steps: string[]
  cite: { doc: string; section: string; text: string; url: string }[]
}
export function diagnose(f: Features): Diagnosis {
  const rv = Math.max(f.rvMean, 0)
  const rt = Math.max(f.rtMean, 0)
  const ang = Math.atan2(rt / 20, rv)
  const mag = Math.hypot(rv, rt / 20)
  const scored = (Object.keys(MODES) as FaultMode[])
    .map((m) => {
      const [pv, pt] = MODES[m].proto
      const d = Math.abs(ang - Math.atan2(pt / 20, pv))
      const conf = Math.max(0.15, Math.min(0.95, 1 - d / 0.55)) * Math.max(0.5, Math.min(1, mag / 0.25))
      return { m, conf }
    })
    .sort((x, y) => y.conf - x.conf)
  const top = scored[0]
  const kb = MODES[top.m]
  // confidence falls when the second hypothesis is close behind
  const conf = Math.max(0.15, Math.min(0.95, top.conf * (0.5 + (top.conf - scored[1].conf))))
  return {
    mode: top.m, confidence: conf, alt: scored[1].m, altConfidence: scored[1].conf,
    action: kb.action, steps: kb.steps, cite: kb.cite,
  }
}

// ---------- Resource agent ----------
export interface Resources {
  parts: { no: string; desc: string; qty: number; inStock: boolean; etaHours: number }[]
  partsEtaHours: number
  skill: string
  candidates: { id: string; name: string; shift: string }[]
}
export function resources(a: Asset, mode: FaultMode): Resources {
  const kb = MODES[mode]
  const parts = kb.parts.map((x) => {
    const st = partStock(x.no, a.type)
    return { ...x, inStock: st.inStock, etaHours: st.inStock ? 0 : st.leadDays * 24 }
  })
  return {
    parts,
    partsEtaHours: Math.max(0, ...parts.map((x) => x.etaHours)),
    skill: kb.skill,
    candidates: TECHS.filter((t) => t.skills.includes(kb.skill)).map((t) => ({ id: t.id, name: t.name, shift: t.shift })),
  }
}

// ---------- Planner agent ----------
export interface Plan {
  type: 'immediate' | 'window' | 'sunday'
  ready: number
  slotStart: number
  slotEnd: number
  durationH: number
  techName: string
  callIn: boolean
  horizonH: number
  withinHorizon: boolean
  workOrder: { id: string; title: string; priority: string; asset: string; start: string; end: string; tech: string; parts: string[]; steps: string[] }
}
export function plan(a: Asset, verdict: Verdict, mode: FaultMode, h: number, res: Resources): Plan {
  const ln = LINES.find((l) => l.id === a.line)!
  const dur = MODES[mode].hours
  const prep = verdict === 'Act now' ? 2 : 4
  const ready = Math.max(h + prep, h + res.partsEtaHours)
  let slotStart = ready
  let type: Plan['type'] = 'immediate'
  if (verdict === 'Plan in window') {
    let best = Infinity
    let bt: Plan['type'] = 'window'
    for (let d = Math.floor(ready / 24); d < Math.floor(ready / 24) + 12; d++) {
      const w = d * 24 + ln.windowStart
      if (w >= ready && ln.windowLen >= dur && !isSunday(w) && w < best) { best = w; bt = 'window' }
      const sun = d * 24
      if (isSunday(sun) && sun >= ready && sun < best) { best = sun; bt = 'sunday' }
    }
    slotStart = best
    type = bt
  }
  const horizonH = verdict === 'Act now' ? 48 : 168
  const hod = slotStart % 24
  const onTech = TECHS.find((t) => t.skills.includes(res.skill) && onShift(t, hod))
  const tech = onTech || TECHS.find((t) => t.skills.includes(res.skill))!
  const slotEnd = slotStart + dur
  return {
    type, ready, slotStart, slotEnd, durationH: dur, techName: tech.name, callIn: !onTech, horizonH,
    withinHorizon: slotStart - h <= horizonH,
    workOrder: {
      id: `WO-${h}-${a.id}`,
      title: `${mode}: ${a.type} ${a.id}`,
      priority: verdict === 'Act now' ? 'P1' : 'P2',
      asset: `${a.id} ${a.name}`,
      start: iso(slotStart),
      end: iso(slotEnd),
      tech: tech.name + (onTech ? '' : ' (call-in)'),
      parts: res.parts.map((x) => `${x.qty} x ${x.no}${x.inStock ? '' : ' (order, ETA ' + Math.round(x.etaHours / 24) + ' days)'}`),
      steps: MODES[mode].steps,
    },
  }
}

// ---------- Comms agent ----------
export function comms(a: Asset, verdict: Verdict, mode: FaultMode, pl: Plan, res: Resources) {
  const when = fmt(pl.slotStart)
  const missing = res.parts.filter((x) => !x.inStock)
  return {
    supervisor: `${verdict}: ${a.id} ${a.type} shows ${mode.toLowerCase()}. Proposed repair ${when} for about ${pl.durationH} h. Approve to create the work order.`,
    technician: `${pl.techName}: you are assigned ${a.id} on ${when}. Expect ${mode.toLowerCase()}; bring ${res.parts.map((x) => x.no).join(', ')}.${pl.callIn ? ' This slot is outside your shift, so it is a call-in.' : ''}`,
    stores: missing.length
      ? `Stores: please expedite ${missing.map((x) => x.no).join(', ')} for ${a.id}. Needed by ${when}.`
      : `Stores: please reserve ${res.parts.map((x) => x.no).join(', ')} for ${a.id}, pick-up before ${when}.`,
  }
}

// ---------- Orchestrator: a state machine that loops back when evidence is missing ----------
export interface TraceStep {
  agent: string
  tool: string
  summary: string
  kind: 'ok' | 'loop' | 'skip'
}
export interface Result {
  candidate: Candidate
  asset: Asset
  features: Features
  context: Context
  adjudication: Adjudication
  diagnosis?: Diagnosis
  resources?: Resources
  plan?: Plan
  comms?: ReturnType<typeof comms>
  escalated: boolean
  trace: TraceStep[]
}

export function runPipeline(p: Plant, c: Candidate, outcomes: Outcomes): Result {
  const a = p.assets.find((x) => x.id === c.assetId)!
  const h = c.hour
  const trace: TraceStep[] = []

  let f = computeFeatures(p, a, h)
  trace.push({ agent: 'Signal', tool: 'time-series, per-asset baselines', kind: f.ok ? 'ok' : 'loop', summary: f.ok ? `Built load-binned baseline from ${f.history} clean hours` : `${f.note}` })
  if (!f.ok) {
    f = computeFeatures(p, a, h, true)
    trace.push({ agent: 'Orchestrator', tool: 'loop back to Signal', kind: 'loop', summary: f.ok ? 'Retried with a shorter history requirement' : 'Still not enough history, failing open to a human' })
  }

  const ctx = contextFor(p, a, h)
  trace.push({ agent: 'Context', tool: 'PLC tags, CMMS history, production plan', kind: 'ok', summary: `${ctx.lineName}, load ${ctx.loadPct}%, ambient ${ctx.ambient.toFixed(0)} C${ctx.startup ? ', restarted recently' : ''}` })

  const adj = assetAdj(outcomes, a.id)
  const adjud = adjudicate(f, c, ctx, adj)
  trace.push({ agent: 'Adjudicator', tool: 'scoring rules, outcome history', kind: 'ok', summary: `${adjud.verdict} at confidence ${adjud.confidence.toFixed(2)} (threshold z ${adjud.threshold.toFixed(1)})` })

  const escalated = adjud.verdict === 'Act now' || adjud.verdict === 'Plan in window' || (adjud.verdict === 'Watch' && adjud.needsHuman)
  const res: Result = { candidate: c, asset: a, features: f, context: ctx, adjudication: adjud, escalated, trace }

  if (adjud.verdict === 'Act now' || adjud.verdict === 'Plan in window') {
    let d = diagnose(f)
    trace.push({ agent: 'Diagnosis', tool: 'public manual excerpts, failure signatures', kind: 'ok', summary: `${d.mode} at ${d.confidence.toFixed(2)}, alternative ${d.alt}` })
    if (d.confidence < 0.5) {
      const wf = computeFeatures(p, a, h, true)
      if (wf.ok) d = diagnose(wf)
      trace.push({ agent: 'Orchestrator', tool: 'loop back to Diagnosis', kind: 'loop', summary: `Low confidence, re-ran on a wider window: ${d.mode} at ${d.confidence.toFixed(2)}` })
      if (d.confidence < 0.5) adjud.needsHuman = true
    }
    res.diagnosis = d
    const rs = resources(a, d.mode)
    trace.push({ agent: 'Resource', tool: 'SAP stock, technician roster', kind: 'ok', summary: rs.partsEtaHours ? `Parts missing, earliest ETA ${Math.round(rs.partsEtaHours / 24)} days` : 'All parts in stock' })
    const pl = plan(a, adjud.verdict, d.mode, h, rs)
    trace.push({ agent: 'Planner', tool: 'production schedule, draft work order', kind: 'ok', summary: `Slot ${fmt(pl.slotStart)}${pl.withinHorizon ? '' : ', outside the risk horizon, expedite'}` })
    res.resources = rs
    res.plan = pl
    res.comms = comms(a, adjud.verdict, d.mode, pl, rs)
    trace.push({ agent: 'Comms', tool: 'supervisor, technician, stores', kind: 'ok', summary: 'Drafted three messages' })
  } else {
    trace.push({ agent: 'Diagnosis', tool: 'public manual excerpts, failure signatures', kind: 'skip', summary: 'Skipped: nothing to diagnose' })
    trace.push({ agent: 'Resource, Planner, Comms', tool: 'n/a', kind: 'skip', summary: 'Skipped: no repair to plan' })
  }
  return res
}
