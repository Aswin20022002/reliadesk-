// Tool-calling Diagnosis agent.
// A language model investigates one escalated alert by calling tools that read the same plant data
// the rest of the pipeline uses. It can only propose a diagnosis. Verdicts, thresholds, stock checks
// and scheduling stay in plain code, and any invalid, ungrounded or disagreeing output is flagged
// for a human or replaced by the rule-based diagnosis.
import { chat, LLMUnavailable, type Msg, type ToolDef } from './llm'
import { MODES } from './kb'
import { resources, type Outcomes, type Result } from './agents'
import { runOne } from './engine'
import { referenceDefectFrequencies } from './refBearing'
import { fmt } from './time'
import type { FaultMode } from './plant'

const MAX_ITER = 8
const MAX_TOOL_CALLS = 6
const modeNames = Object.keys(MODES) as FaultMode[]

export interface AgentStep { n: number; kind: 'tool' | 'model'; name: string; args?: unknown; summary: string; ms: number }
export interface AgentOutput {
  skipped?: string
  source: 'llm' | 'rules'
  provider?: string
  model?: string
  fallbackReason?: string
  steps: AgentStep[]
  usage: { prompt: number; completion: number; calls: number }
  totalMs: number
  verdict: string
  rule: { mode: FaultMode; confidence: number }
  verifier?: { ran: boolean; approved: boolean | null; concerns: string[]; revised: boolean }
  comms?: { source: 'llm' | 'template'; supervisor: string; technician: string; stores: string; note?: string }
  final: {
    mode: FaultMode
    confidence: number
    rationale: string
    citations: { doc: string; section: string }[]
    agreesWithRules: boolean
    needsHuman: boolean
    flags: string[]
  }
}

const TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'get_signal_evidence', description: 'Measured evidence for this alert: vibration and temperature rise versus the asset normal for its load, trend, persistence, load and the verdict reasons.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'list_failure_modes', description: 'The failure modes in the knowledge base with their typical signature (vibration rise ratio and temperature rise in deg C).', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'lookup_manual', description: 'Manual, FMEA and work-order excerpts, the repair action and the parts for one failure mode.', parameters: { type: 'object', properties: { mode: { type: 'string', enum: modeNames } }, required: ['mode'], additionalProperties: false } } },
  { type: 'function', function: { name: 'check_parts', description: 'Spare-part stock and lead time for the repair of one failure mode on this asset.', parameters: { type: 'object', properties: { mode: { type: 'string', enum: modeNames } }, required: ['mode'], additionalProperties: false } } },
  { type: 'function', function: { name: 'reference_bearing_frequencies', description: 'Characteristic bearing defect frequencies of the reference rig (NASA IMS, Rexnord ZA-2115 at 2000 rpm). Use only to explain what a spectrum peak would mean; plant assets need their own geometry.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
]

function runTool(name: string, args: Record<string, unknown>, r: Result): unknown {
  const f = r.features
  switch (name) {
    case 'get_signal_evidence':
      return {
        asset: `${r.asset.id} ${r.asset.type}`,
        verdict: r.adjudication.verdict,
        verdictReasons: r.adjudication.evidence,
        vibrationRiseVsNormalPct: +(f.rvMean * 100).toFixed(1),
        temperatureRiseDegC: +f.rtMean.toFixed(1),
        vibrationTrendPerDay: +f.trendV.toFixed(3),
        temperatureTrendPerDay: +f.trendT.toFixed(2),
        persistenceHours: f.persistence,
        loadPct: r.context.loadPct,
        recentlyRestarted: r.context.startup,
        cleanHistoryHours: f.history,
      }
    case 'list_failure_modes':
      return modeNames.map((m) => ({ mode: m, typicalVibrationRiseRatio: MODES[m].proto[0], typicalTempRiseDegC: MODES[m].proto[1] }))
    case 'lookup_manual': {
      const m = String(args.mode) as FaultMode
      if (!MODES[m]) throw new Error('unknown mode')
      return { mode: m, action: MODES[m].action, excerpts: MODES[m].cite, parts: MODES[m].parts.map((p) => `${p.no} ${p.desc}`) }
    }
    case 'check_parts': {
      const m = String(args.mode) as FaultMode
      if (!MODES[m]) throw new Error('unknown mode')
      const rs = resources(r.asset, m)
      return { parts: rs.parts.map((p) => ({ no: p.no, inStock: p.inStock, leadDays: Math.round(p.etaHours / 24) })), techniciansWithSkill: rs.candidates.length }
    }
    case 'reference_bearing_frequencies':
      return referenceDefectFrequencies()
    default:
      throw new Error('unknown tool')
  }
}

const brief = (v: unknown) => {
  const s = JSON.stringify(v)
  return s.length > 140 ? s.slice(0, 137) + '...' : s
}

const SYSTEM =
  'You are the Diagnosis agent in ReliaDesk, a maintenance decision desk. A shift supervisor needs the most likely failure mode for one escalated alert. ' +
  'Investigate with the tools: first get_signal_evidence, then compare it with list_failure_modes, then lookup_manual for your top candidate and the runner-up, and check_parts for your choice. ' +
  'Use only tool results. Never invent numbers, parts or documents. You do not decide the verdict, the schedule or any work order; you only propose the diagnosis. ' +
  'If the evidence fits two modes about equally, say so and set needs_human to true. ' +
  'Finish with ONLY a JSON object, no other text: {"mode": one of the failure modes, "confidence": number 0 to 1, "rationale": two or three sentences, "citations": [{"doc": string, "section": string}], "needs_human": boolean}. ' +
  'Citations must be copied exactly from lookup_manual excerpts. Do not use em dashes.'

function parseFinal(text: string): Record<string, unknown> | null {
  const t = text.replace(/```json|```/g, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(t.slice(a, b + 1)) } catch { return null }
}

function validate(raw: Record<string, unknown>, r: Result) {
  const flags: string[] = []
  const mode = raw.mode as FaultMode
  if (!modeNames.includes(mode)) return { error: 'mode not in knowledge base' as const }
  let conf = Number(raw.confidence)
  if (!Number.isFinite(conf)) conf = 0.5
  conf = Math.max(0, Math.min(1, conf))
  const rationale = String(raw.rationale || '').replace(/\u2014|\u2013/g, ',').slice(0, 700)
  if (!rationale) return { error: 'no rationale' as const }
  const allowed = MODES[mode].cite
  const cites = (Array.isArray(raw.citations) ? raw.citations : [])
    .map((c) => ({ doc: String((c as { doc?: unknown }).doc || ''), section: String((c as { section?: unknown }).section || '') }))
    .filter((c) => allowed.some((a) => a.doc === c.doc && a.section === c.section))
  if (!cites.length) flags.push('no grounded citation, treat as unverified')
  const rule = r.diagnosis!
  const agrees = mode === rule.mode
  if (!agrees) flags.push(`disagrees with the rule-based diagnosis (${rule.mode}), human review`)
  const needsHuman = raw.needs_human === true || !agrees || !cites.length || conf < 0.5
  return { value: { mode, confidence: conf, rationale, citations: cites, agreesWithRules: agrees, needsHuman, flags } }
}


// ---------- Verifier agent: an independent second model call that checks the first one ----------
const VERIFIER_SYSTEM =
  'You are an independent reviewer of a maintenance diagnosis. You get measured evidence, a proposed failure mode with its rationale, and the manual excerpts it cites. ' +
  'Approve only if the rationale is consistent with the evidence numbers and the cited excerpts support what is claimed. Do not add facts. ' +
  'Reply with ONLY a JSON object: {"approve": boolean, "concerns": [short strings]}. Use an empty concerns list when you approve. Do not use em dashes.'

async function runVerifier(r: Result, v: { mode: FaultMode; confidence: number; rationale: string; citations: { doc: string; section: string }[] }) {
  const excerpts = MODES[v.mode].cite.filter((c) => v.citations.some((x) => x.doc === c.doc && x.section === c.section)).map((c) => ({ doc: c.doc, section: c.section, text: c.text }))
  const payload = { evidence: runTool('get_signal_evidence', {}, r), signatures: runTool('list_failure_modes', {}, r), proposal: { mode: v.mode, confidence: v.confidence, rationale: v.rationale }, citedExcerpts: excerpts }
  const res = await chat({ messages: [{ role: 'system', content: VERIFIER_SYSTEM }, { role: 'user', content: JSON.stringify(payload) }], maxTokens: 300 })
  const raw = parseFinal(res.message.content || '')
  const concerns = Array.isArray(raw?.concerns) ? (raw!.concerns as unknown[]).map((c) => String(c).slice(0, 200)).slice(0, 4) : []
  const approved = typeof raw?.approve === 'boolean' ? (raw.approve as boolean) : null
  return { approved, concerns, res }
}

// ---------- Comms agent: drafts the three messages, then code checks them against the plan ----------
const COMMS_SYSTEM =
  'You are the Comms agent in ReliaDesk. Write three short messages (supervisor, technician, stores), each under 280 characters, plain and specific, using ONLY the facts given. ' +
  'Include the asset id and the slot time in the supervisor and technician messages, the technician name in the technician message, and every listed part number in the stores message. Do not invent names, times or part numbers. Do not use em dashes. ' +
  'Reply with ONLY a JSON object: {"supervisor": string, "technician": string, "stores": string}.'

async function runComms(r: Result) {
  const pl = r.plan!
  const rs = r.resources!
  const when = fmt(pl.slotStart)
  const allowed = rs.parts.map((p) => p.no)
  const facts = { verdict: r.adjudication.verdict, asset: `${r.asset.id} ${r.asset.type}`, failureMode: r.diagnosis!.mode, slot: when, durationHours: pl.durationH, technician: pl.techName, callIn: pl.callIn, parts: rs.parts.map((p) => ({ no: p.no, inStock: p.inStock })) }
  const res = await chat({ messages: [{ role: 'system', content: COMMS_SYSTEM }, { role: 'user', content: JSON.stringify(facts) }], maxTokens: 500 })
  const raw = parseFinal(res.message.content || '')
  const clean = (x: unknown) => String(x || '').replace(/\u2014|\u2013/g, ',').trim().slice(0, 400)
  const m = { supervisor: clean(raw?.supervisor), technician: clean(raw?.technician), stores: clean(raw?.stores) }
  const problems: string[] = []
  if (!m.supervisor.includes(r.asset.id) || !m.supervisor.includes(when)) problems.push('supervisor message misses asset or slot')
  if (!m.technician.includes(pl.techName) || !m.technician.includes(r.asset.id) || !m.technician.includes(when)) problems.push('technician message misses name, asset or slot')
  if (!allowed.every((no) => m.stores.includes(no))) problems.push('stores message misses a part number')
  const seen = (m.supervisor + ' ' + m.technician + ' ' + m.stores).match(/\b[A-Z]{2,}-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g) || []
  const allowedAll = new Set([...allowed, r.asset.id])
  if (seen.some((t) => !allowedAll.has(t) && !/^L\d+-\d+$/.test(t) && !/^A-\d/.test(t))) problems.push('mentions a part number that is not in the plan')
  return { m, problems, res }
}

export async function runAgent(alertId: string, outcomes: Outcomes): Promise<AgentOutput | null> {
  const r = runOne(alertId, outcomes)
  if (!r) return null
  const t0 = Date.now()
  const base = { steps: [] as AgentStep[], usage: { prompt: 0, completion: 0, calls: 0 }, verdict: r.adjudication.verdict }
  if (!r.diagnosis) {
    return { ...base, skipped: 'No diagnosis is needed for this verdict.', source: 'rules', totalMs: 0, rule: { mode: 'Bearing wear', confidence: 0 }, final: { mode: 'Bearing wear', confidence: 0, rationale: '', citations: [], agreesWithRules: true, needsHuman: false, flags: [] } }
  }
  const rule = { mode: r.diagnosis.mode, confidence: +r.diagnosis.confidence.toFixed(2) }
  const steps = base.steps
  const usage = base.usage

  const rulesOutput = (reason: string): AgentOutput => {
    // Deterministic run of the same tools, so the desk still shows the investigation without a key.
    const seq: [string, Record<string, unknown>][] = [['get_signal_evidence', {}], ['list_failure_modes', {}], ['lookup_manual', { mode: rule.mode }], ['check_parts', { mode: rule.mode }]]
    const out: AgentStep[] = seq.map(([name, args], i) => {
      const s = Date.now()
      const res = runTool(name, args, r)
      return { n: i + 1, kind: 'tool' as const, name, args, summary: brief(res), ms: Date.now() - s }
    })
    return {
      source: 'rules', fallbackReason: reason, steps: out, comms: r.comms ? { source: 'template' as const, ...r.comms } : undefined, usage: { prompt: 0, completion: 0, calls: 0 }, totalMs: Date.now() - t0, verdict: r.adjudication.verdict, rule,
      final: { mode: r.diagnosis!.mode, confidence: rule.confidence, rationale: `Rule-based diagnosis from the vibration and temperature signature. ${r.diagnosis!.action}.`, citations: r.diagnosis!.cite.map((c) => ({ doc: c.doc, section: c.section })), agreesWithRules: true, needsHuman: r.adjudication.needsHuman, flags: [] },
    }
  }

  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Alert on ${r.asset.id} (${r.asset.type}), legacy trigger: ${r.candidate.trigger}. The desk verdict is ${r.adjudication.verdict}. Diagnose the most likely failure mode.` },
  ]
  let provider = ''
  let model = ''
  let toolCalls = 0
  let revised = false
  const verifier: NonNullable<AgentOutput['verifier']> = { ran: false, approved: null, concerns: [], revised: false }
  try {
    for (let i = 0; i < MAX_ITER; i++) {
      const last = i === MAX_ITER - 1 || toolCalls >= MAX_TOOL_CALLS
      const res = await chat({ messages, tools: last ? undefined : TOOLS, maxTokens: 600 })
      provider = res.provider
      model = res.model
      usage.prompt += res.usage.prompt
      usage.completion += res.usage.completion
      usage.calls += 1
      const m = res.message
      if (m.tool_calls?.length && !last) {
        steps.push({ n: steps.length + 1, kind: 'model', name: `${res.provider} chose ${m.tool_calls.length} tool call${m.tool_calls.length > 1 ? 's' : ''}`, summary: m.tool_calls.map((c) => c.function.name).join(', '), ms: res.ms })
        messages.push(m)
        for (const c of m.tool_calls) {
          const s = Date.now()
          let out: unknown
          let args: Record<string, unknown> = {}
          try {
            args = c.function.arguments ? JSON.parse(c.function.arguments) : {}
            toolCalls += 1
            out = toolCalls > MAX_TOOL_CALLS ? { error: 'tool budget used, give your final answer' } : runTool(c.function.name, args, r)
          } catch (e) {
            out = { error: (e as Error).message }
          }
          steps.push({ n: steps.length + 1, kind: 'tool', name: c.function.name, args, summary: brief(out), ms: Date.now() - s })
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out).slice(0, 3500) })
        }
        continue
      }
      const raw = parseFinal(m.content || '')
      if (!raw) { messages.push(m, { role: 'user', content: 'Reply with only the JSON object described.' }); continue }
      const v = validate(raw, r)
      if ('error' in v) { messages.push(m, { role: 'user', content: `Invalid answer (${v.error}). Reply again with only the JSON object.` }); continue }
      steps.push({ n: steps.length + 1, kind: 'model', name: revised ? 'Revised answer' : 'Diagnosis answer', summary: `${v.value.mode} at ${v.value.confidence.toFixed(2)}${v.value.agreesWithRules ? '' : ' (differs from rules)'}`, ms: res.ms })

      // Verifier agent: an independent check that can send the diagnosis back once.
      let ver: Awaited<ReturnType<typeof runVerifier>> | null = null
      try { ver = await runVerifier(r, v.value) } catch { steps.push({ n: steps.length + 1, kind: 'model', name: 'Verifier agent', summary: 'unavailable, skipped', ms: 0 }) }
      if (ver) {
        verifier.ran = true
        verifier.approved = ver.approved
        verifier.concerns = ver.concerns
        usage.prompt += ver.res.usage.prompt
        usage.completion += ver.res.usage.completion
        usage.calls += 1
        steps.push({ n: steps.length + 1, kind: 'model', name: `Verifier agent (${ver.res.provider})`, summary: ver.approved === null ? 'no clear verdict' : ver.approved ? 'approved' : `concerns: ${ver.concerns.join('; ') || 'none given'}`, ms: ver.res.ms })
        if (ver.approved === false && ver.concerns.length && !revised) {
          revised = true
          verifier.revised = true
          messages.push(m, { role: 'user', content: `An independent reviewer raised concerns: ${ver.concerns.join('; ')}. Re-check with the tools if needed and reply again with only the JSON object.` })
          steps.push({ n: steps.length + 1, kind: 'model', name: 'Loop back', summary: 'verifier sent the diagnosis back for another pass', ms: 0 })
          continue
        }
        if (ver.approved === false) {
          v.value.needsHuman = true
          v.value.flags.push(`verifier still has concerns after one revision: ${ver.concerns.join('; ')}`)
        }
      }

      // Comms agent: only when the agent agrees with the rule-based plan, so the plan and parts match the diagnosis.
      let commsOut: AgentOutput['comms']
      if (r.plan && r.resources && r.comms && v.value.agreesWithRules && !v.value.needsHuman) {
        try {
          const c = await runComms(r)
          usage.prompt += c.res.usage.prompt
          usage.completion += c.res.usage.completion
          usage.calls += 1
          if (c.problems.length) {
            commsOut = { source: 'template', ...r.comms, note: `Model draft rejected by checks: ${c.problems.join('; ')}` }
          } else {
            commsOut = { source: 'llm', ...c.m }
          }
          steps.push({ n: steps.length + 1, kind: 'model', name: `Comms agent (${c.res.provider})`, summary: c.problems.length ? 'draft rejected, template used' : 'drafted and checked against the plan', ms: c.res.ms })
        } catch {
          commsOut = { source: 'template', ...r.comms, note: 'LLM unavailable' }
        }
      } else if (r.comms) {
        commsOut = { source: 'template', ...r.comms, note: v.value.needsHuman || !v.value.agreesWithRules ? 'Template used until a human confirms the diagnosis' : undefined }
      }
      return { source: 'llm', provider, model, steps, usage, totalMs: Date.now() - t0, verdict: r.adjudication.verdict, rule, verifier, comms: commsOut, final: v.value }
    }
    return { ...rulesOutput('model did not return a valid answer'), provider, model }
  } catch (e) {
    const why = e instanceof LLMUnavailable ? (e.failed.length ? e.failed.join('; ') : 'no free LLM key configured') : 'unexpected error'
    return rulesOutput(why)
  }
}
