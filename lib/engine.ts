import { getPlant, HOURS, LEARN_H, VIB_ALARM, TEMP_ALARM, faultGain, Plant } from './plant'
import { Candidate, Result, Outcomes, runPipeline, computeFeatures, Trigger } from './agents'
import { MODES, partStock } from './kb'
import { IMS } from './imsData'

let candCache: Candidate[] | null = null

function truthAt(p: Plant, assetId: string, h: number) {
  const f = p.faults.find((x) => x.assetId === assetId)
  if (f && h >= f.onset && h < f.failAt && faultGain(f, h) >= 0.05) return { real: true, faultId: f.id, mode: f.mode }
  return { real: false }
}

export function getCandidates(): Candidate[] {
  if (candCache) return candCache
  const p = getPlant()
  const out: Candidate[] = []
  for (const a of p.assets) {
    const s = p.series[a.id]
    let last = -999
    for (let h = LEARN_H; h < HOURS; h++) {
      if (!s.running[h]) continue
      const v = s.vib[h] > VIB_ALARM
      const t = s.temp[h] > TEMP_ALARM
      if ((v || t) && h - last >= 12) {
        last = h
        const trigger: Trigger = v && t ? 'both' : v ? 'vibration' : 'temperature'
        out.push({ id: `A-${h}-${a.id}`, assetId: a.id, hour: h, trigger, truth: truthAt(p, a.id, h) })
      }
    }
  }
  // drift sweeps: the desk also raises its own alerts when a sustained drift appears, before any fixed threshold trips
  for (const a of p.assets) {
    let lastCand = -999
    for (let h = LEARN_H; h < HOURS; h += 6) {
      const hasRecent = out.some((c) => c.assetId === a.id && h - c.hour >= 0 && h - c.hour < 48)
      if (hasRecent || h - lastCand < 48) continue
      const f = computeFeatures(p, a, h)
      if (f.ok && ((f.rvMean >= 0.1 && f.zV >= 5) || (f.rtMean >= 5 && f.zT >= 5))) {
        lastCand = h
        out.push({ id: `D-${h}-${a.id}`, assetId: a.id, hour: h, trigger: 'drift', truth: truthAt(p, a.id, h) })
      }
    }
  }
  out.sort((x, y) => x.hour - y.hour || x.assetId.localeCompare(y.assetId))
  candCache = out
  return out
}

export function summarize(outcomes: Outcomes) {
  const p = getPlant()
  const items = getCandidates().map((c) => {
    const r = runPipeline(p, c, outcomes)
    return {
      id: c.id, assetId: c.assetId, hour: c.hour, trigger: c.trigger,
      verdict: r.adjudication.verdict, confidence: +r.adjudication.confidence.toFixed(2),
      needsHuman: r.adjudication.needsHuman, reason: r.adjudication.reason, line: r.asset.line,
      truthReal: c.truth.real,
    }
  })
  return items
}

export function seriesWindow(assetId: string, hour: number) {
  const p = getPlant()
  const s = p.series[assetId]
  const lo = Math.max(0, hour - 95)
  const hi = Math.min(HOURS - 1, hour + 24)
  return {
    from: lo,
    alertAt: hour,
    vib: s.vib.slice(lo, hi + 1),
    temp: s.temp.slice(lo, hi + 1),
    load: s.load.slice(lo, hi + 1),
    running: s.running.slice(lo, hi + 1),
  }
}

export function runOne(alertId: string, outcomes: Outcomes): Result | null {
  const c = getCandidates().find((x) => x.id === alertId)
  if (!c) return null
  return runPipeline(getPlant(), c, outcomes)
}

// ---------- Replay evaluation: the same 30 days through the static baseline and through ReliaDesk ----------
export function evaluate(responseRate: number, approvalRate = 0.9) {
  const p = getPlant()
  const cands = getCandidates()
  const results = cands.map((c) => runPipeline(p, c, {}))
  const stat = cands.filter((c) => c.trigger !== 'drift')

  const baseEsc = stat.length
  const baseFalse = stat.filter((c) => !c.truth.real).length
  const rd = results.filter((r) => r.escalated)
  const rdFalse = rd.filter((r) => !r.candidate.truth.real).length
  const rdFalseNoHuman = rd.filter((r) => !r.candidate.truth.real && !(r.adjudication.verdict === 'Watch' && r.adjudication.needsHuman)).length

  const rows = p.faults.map((f) => {
    const asset = p.assets.find((x) => x.id === f.assetId)!
    const sqAlert = stat.find((c) => c.assetId === f.assetId && c.truth.real && c.hour < f.failAt)
    const rdHit = results.find((r) => r.candidate.assetId === f.assetId && r.candidate.truth.real && r.candidate.hour < f.failAt && r.escalated)
    const later = results.filter((r) => r.candidate.assetId === f.assetId && r.candidate.truth.real && r.candidate.hour <= f.failAt - 24 && r.diagnosis)
    const latest = later.length ? later[later.length - 1] : undefined
    return { f, asset, sqAlert, rdHit, kb: MODES[f.mode], detectedAt: rdHit ? rdHit.candidate.hour : null, rdMode: rdHit?.diagnosis?.mode, latestMode: latest?.diagnosis?.mode }
  })

  // Parts ETA via the same stock function the Resource agent uses
  const etaFor = (assetType: string, mode: keyof typeof MODES) => {
    let eta = 0
    for (const x of MODES[mode].parts) {
      const hsh = stockEta(x.no, assetType)
      if (hsh > eta) eta = hsh
    }
    return eta
  }

  const table = rows.map(({ f, asset, sqAlert, rdHit, kb, rdMode, latestMode }) => {
    const eta = etaFor(asset.type, f.mode)
    const sqLead = sqAlert ? f.failAt - sqAlert.hour : null
    const sqDone = sqAlert ? sqAlert.hour + 4 + Math.max(eta, 0) + kb.hours : Infinity
    const sqFeasible = sqAlert ? sqDone < f.failAt : false
    let rdDone = Infinity
    if (rdHit) rdDone = rdHit.plan ? rdHit.plan.slotEnd : rdHit.candidate.hour + 8 + eta + kb.hours
    const rdFeasible = rdDone < f.failAt
    const rdLead = rdHit ? f.failAt - rdHit.candidate.hour : null
    return {
      fault: f.id, source: f.source ?? 'Simulated rise', asset: f.assetId, type: asset.type, mode: f.mode, failAt: f.failAt, downtimeHrs: f.downtimeHrs,
      sqLead, rdLead, sqFeasible, rdFeasible, rdMode: rdMode || null, modeCorrect: rdMode === f.mode, latestMode: latestMode || null, latestCorrect: latestMode === f.mode, partsEtaDays: Math.round(eta / 24),
    }
  })

  const detected = table.filter((t) => t.rdLead !== null && t.rdLead >= 24).length
  const missed = table.length - detected
  const downtimeFor = (r: number, ar: number) => {
    const sq = table.reduce((s, t) => s + t.downtimeHrs * (1 - r * (t.sqFeasible ? 1 : 0)), 0)
    const rdd = table.reduce((s, t) => s + t.downtimeHrs * (1 - ar * (t.rdFeasible && (t.rdLead ?? 0) >= 24 ? 1 : 0)), 0)
    return { sq, rd: rdd, cut: sq > 0 ? 1 - rdd / sq : 0 }
  }
  const dt = downtimeFor(responseRate, approvalRate)
  const sens = [0.3, 0.5, 0.7, 0.9].flatMap((r) => [0.7, 0.9].map((ar) => ({ r, ar, ...downtimeFor(r, ar) })))
  const minutesPerFalse = 45
  const freedHrsWeek = ((baseFalse - rdFalse) * minutesPerFalse) / 60 / (30 / 7)

  const verdicts = { 'Act now': 0, 'Plan in window': 0, Watch: 0, Suppress: 0 } as Record<string, number>
  results.forEach((r) => (verdicts[r.adjudication.verdict] += 1))

  return {
    data: { citation: IMS.citation, featureSource: IMS.featureSource, realFaults: p.faults.filter((x) => x.curve).length, simulatedFaults: p.faults.filter((x) => !x.curve).length, noiseSamples: IMS.noise.length },
    plant: { assets: p.assets.length, lines: p.lines.length, days: 30, learnDays: LEARN_H / 24, faults: p.faults.length },
    noise: {
      staticAlerts: baseEsc, staticFalse: baseFalse, staticFalsePct: baseFalse / baseEsc,
      rdEscalations: rd.length, rdFalse, rdFalseNoHuman,
      falseCut: baseFalse ? 1 - rdFalse / baseFalse : 0,
      totalCut: 1 - rd.length / baseEsc,
      verdicts, freedHrsWeek,
    },
    faults: { total: table.length, detected, missed, recall: detected / table.length, diagnosisAccuracyFirst: table.filter((t) => t.modeCorrect).length / table.length, diagnosisAccuracyLatest: table.filter((t) => t.latestCorrect).length / table.length, table },
    downtime: { responseRate, approvalRate, statusQuoHrs: dt.sq, reliadeskHrs: dt.rd, cut: dt.cut, sensitivity: sens },
    assumptions: [
      'Data: bearing-wear faults replay real vibration run-to-failure curves from the NASA IMS bearing dataset, and every asset carries real healthy-bearing measurement noise from the same dataset. The plant itself (lines, loads, start-ups, ambient heat, temperature, the other three fault modes, parts, roster) is simulated with a fixed seed, so the replay is repeatable. The first 7 days are a shadow-mode learning period with no verdicts.',
      'Status quo: the supervisor acts on a real fault alert with the stated response rate, 4 hours after the alert, and repair also waits for parts. ReliaDesk: the supervisor approves a correct recommendation with the stated approval rate. Both rates are assumptions to be measured in the Alert Audit.',
      'A fault counts as caught if ReliaDesk escalates it at least 24 hours before failure, and prevented only if the planned repair ends before failure.',
      'Each false escalation costs 45 minutes of supervisor time. This is the modelled figure behind the 180 hours a week on the slides.',
      'Results show the product logic working on a plant we designed. They are not a claim about real plants until the shadow-mode pilot.',
    ],
  }
}

// the same deterministic stock rule used by the Resource agent, in hours
function stockEta(no: string, assetType: string) {
  const s = partStock(no, assetType)
  return s.inStock ? 0 : s.leadDays * 24
}
