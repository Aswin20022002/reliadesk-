'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { Result, Verdict, Outcomes, OutcomeLabel } from '@/lib/agents'
import { fmt } from '@/lib/time'
import { VIB_ALARM, TEMP_ALARM } from '@/lib/plant'

interface Item {
  id: string
  assetId: string
  hour: number
  trigger: string
  verdict: Verdict
  confidence: number
  needsHuman: boolean
  reason: string
  line: string
  truthReal: boolean
}
interface Series {
  from: number
  alertAt: number
  vib: number[]
  temp: number[]
  load: number[]
  running: boolean[]
}
interface Detail {
  result: Result
  series: Series
  truth: { real: boolean; mode?: string; faultFailAt?: number }
}
type Decision = { action: string; at: string; note?: string }

const cls = (v: Verdict) => (v === 'Act now' ? 'act' : v === 'Plan in window' ? 'plan' : v === 'Watch' ? 'watch' : 'supp')
const VERDICTS: Verdict[] = ['Act now', 'Plan in window', 'Watch', 'Suppress']

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k)
    return v ? (JSON.parse(v) as T) : d
  } catch {
    return d
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable, state stays in memory */
  }
}

function Chart({ s, title, unit, alarm, color }: { s: Series; title: string; unit: string; alarm?: number; color: string }) {
  const data = title === 'Vibration' ? s.vib : s.temp
  const W = 520
  const H = 130
  const lo = Math.min(...data.filter((_, i) => s.running[i]), alarm ?? Infinity) * 0.9
  const hi = Math.max(...data, alarm ?? 0) * 1.05
  const x = (i: number) => (i / (data.length - 1)) * (W - 40) + 34
  const y = (v: number) => H - 18 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (H - 30)
  const pts = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const ax = x(s.alertAt - s.from)
  return (
    <div>
      <div className="note"><b>{title}</b> ({unit}) · last 4 days to the alert, red line is the legacy fixed threshold</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title} chart`}>
        <rect x="34" y="4" width={W - 40} height={H - 22} fill="#F8FAFC" />
        {alarm !== undefined && <line x1="34" x2={W - 6} y1={y(alarm)} y2={y(alarm)} stroke="#D64545" strokeDasharray="4 3" />}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" />
        <line x1={ax} x2={ax} y1="4" y2={H - 18} stroke="#0B1F3A" strokeDasharray="2 2" />
        <text x={ax + 3} y="14" fontSize="10" fill="#0B1F3A">alert</text>
        <text x="2" y="12" fontSize="10" fill="#6B7785">{hi.toFixed(0)}</text>
        <text x="2" y={H - 18} fontSize="10" fill="#6B7785">{lo.toFixed(0)}</text>
      </svg>
    </div>
  )
}

interface AgentOut {
  skipped?: string
  source: 'llm' | 'rules'
  provider?: string
  fallbackReason?: string
  steps: { n: number; kind: string; name: string; summary: string; ms: number }[]
  usage: { prompt: number; completion: number; calls: number }
  totalMs: number
  verdict: string
  verifier?: { ran: boolean; approved: boolean | null; concerns: string[]; revised: boolean }
  comms?: { source: 'llm' | 'template'; supervisor: string; technician: string; stores: string; note?: string }
  final: { mode: string; confidence: number; rationale: string; citations: { doc: string; section: string }[]; needsHuman: boolean; flags: string[] }
}

export default function Desk() {
  const [items, setItems] = useState<Item[]>([])
  const [outcomes, setOutcomes] = useState<Outcomes>({})
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [filter, setFilter] = useState<Verdict | 'All'>('Act now')
  const [line, setLine] = useState('All')
  const [sel, setSel] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [explain, setExplain] = useState<{ text: string; source: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [agent, setAgent] = useState<AgentOut | null>(null)
  const [agentBusy, setAgentBusy] = useState(false)
  const [agentErr, setAgentErr] = useState('')
  const [truth, setTruth] = useState(false)
  const [ready, setReady] = useState(false)
  const [lines, setLines] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    setOutcomes(load('rd_outcomes', {}))
    setDecisions(load('rd_decisions', {}))
    setReady(true)
  }, [])

  const refresh = useCallback(async (o: Outcomes) => {
    const r = await fetch('/api/plant', { method: 'POST', body: JSON.stringify({ outcomes: o }) })
    const j = await r.json()
    setItems(j.items)
    setLines(j.lines)
  }, [])

  useEffect(() => {
    if (ready) refresh(outcomes)
  }, [ready, outcomes, refresh])

  const open = useCallback(
    async (id: string) => {
      setSel(id)
      setExplain(null)
      setAgent(null)
      setAgentErr('')
      const r = await fetch('/api/run', { method: 'POST', body: JSON.stringify({ alertId: id, outcomes }) })
      if (r.ok) setDetail(await r.json())
    },
    [outcomes]
  )

  // keep the open alert in sync when learning changes the verdicts
  useEffect(() => {
    if (sel && ready) open(sel)
  }, [outcomes]) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c: Record<string, number> = { 'Act now': 0, 'Plan in window': 0, Watch: 0, Suppress: 0 }
    items.forEach((i) => (c[i.verdict] += 1))
    return c
  }, [items])
  const escalated = counts['Act now'] + counts['Plan in window']
  const noiseCut = items.length ? Math.round((1 - (escalated + items.filter((i) => i.verdict === 'Watch' && i.needsHuman).length) / items.length) * 100) : 0

  const shown = items
    .filter((i) => (filter === 'All' ? true : i.verdict === filter))
    .filter((i) => (line === 'All' ? true : i.line === line))
    .slice()
    .reverse()

  const logDecision = (id: string, d: Decision) => {
    const n = { ...decisions, [id]: d }
    setDecisions(n)
    save('rd_decisions', n)
  }
  const logOutcome = (id: string, assetId: string, label: OutcomeLabel) => {
    const n = { ...outcomes, [id]: { assetId, label } }
    setOutcomes(n)
    save('rd_outcomes', n)
    logDecision(id, { ...(decisions[id] || { action: 'outcome logged', at: new Date().toISOString() }), note: `Outcome: ${label}` })
  }
  const reset = () => {
    setOutcomes({})
    setDecisions({})
    save('rd_outcomes', {})
    save('rd_decisions', {})
  }
  const askAI = async () => {
    if (!sel) return
    setBusy(true)
    const r = await fetch('/api/explain', { method: 'POST', body: JSON.stringify({ alertId: sel, outcomes }) })
    setExplain(await r.json())
    setBusy(false)
  }

  const runAgent = async () => {
    if (!sel) return
    setAgentBusy(true)
    setAgentErr('')
    try {
      const x = await fetch('/api/agent', { method: 'POST', body: JSON.stringify({ alertId: sel, outcomes }) })
      const j = await x.json()
      if (!x.ok) setAgentErr(j.error || 'The agent could not run.')
      else setAgent(j)
    } catch {
      setAgentErr('Network error, try again.')
    }
    setAgentBusy(false)
  }

  const r = detail?.result
  const dec = sel ? decisions[sel] : undefined
  const escalatable = r && (r.adjudication.verdict === 'Act now' || r.adjudication.verdict === 'Plan in window')

  return (
    <>
      <div className="top">
        <h1>ReliaDesk</h1>
        <span className="tag">Agentic reliability desk · replay plant, 3 lines, 40 assets, real NASA IMS bearing signatures</span>
        <nav>
          <Link href="/" className="on">Desk</Link>
          <Link href="/eval">Replay evaluation</Link>
        </nav>
      </div>

      <div className="kpis">
        <div className="kpi"><b>{items.length}</b><span>legacy threshold alerts, days 8 to 30</span></div>
        <div className="kpi red"><b>{escalated}</b><span>reach the supervisor (Act now, Plan in window)</span></div>
        <div className="kpi"><b>{counts['Watch']}</b><span>on Watch</span></div>
        <div className="kpi"><b>{counts['Suppress']}</b><span>suppressed with a reason, reversible</span></div>
        <div className="kpi"><b>{noiseCut}%</b><span>fewer escalations (fail-open cases counted as escalated)</span></div>
        <div className="kpi"><b>{Object.keys(outcomes).length}</b><span>technician outcomes logged, thresholds learning</span></div>
      </div>

      <div className="wrap">
        <div className="panel">
          <h3>Alert queue</h3>
          <div className="filters">
            {(['All', ...VERDICTS] as const).map((v) => (
              <button key={v} className={'chipbtn' + (filter === v ? ' on' : '')} onClick={() => setFilter(v)}>
                {v}{v !== 'All' ? ` ${counts[v]}` : ''}
              </button>
            ))}
            <select value={line} onChange={(e) => setLine(e.target.value)} aria-label="Line filter">
              <option value="All">All lines</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="list">
            {shown.slice(0, 300).map((i) => (
              <div key={i.id} className={'row' + (sel === i.id ? ' sel' : '')} onClick={() => open(i.id)}>
                <div style={{ flex: 1 }}>
                  <div className="a">{i.assetId} <span className="t">{i.trigger}</span></div>
                  <div className="t">{fmt(i.hour)}</div>
                </div>
                <span className={'pill ' + cls(i.verdict)}>{i.verdict}{i.needsHuman ? ' *' : ''}</span>
              </div>
            ))}
            {!shown.length && <div className="pad muted">No alerts in this view.</div>}
          </div>
          <div className="pad note">* low confidence or missing data, handed to a human. Showing the latest 300.</div>
        </div>

        <div className="stack">
          {!r && <div className="panel pad muted">Select an alert on the left. Start with Act now to see a full verdict, evidence, parts check, plan and draft work order.</div>}
          {r && detail && (
            <>
              <div className="panel pad">
                <div className="hd">
                  <h2>{r.asset.id} · {r.asset.type}</h2>
                  <span className={'pill ' + cls(r.adjudication.verdict)}>{r.adjudication.verdict}{r.adjudication.needsHuman ? ' (human review)' : ''}</span>
                  <span className="muted">confidence {r.adjudication.confidence.toFixed(2)} · {fmt(r.candidate.hour)} · {r.context.lineName}</span>
                </div>
                <p style={{ margin: '8px 0 0' }}><b>{r.adjudication.reason}</b></p>
                <ul className="ev">{r.adjudication.evidence.map((e, k) => <li key={k}>{e}</li>)}</ul>
                <div className="actions" style={{ marginTop: 10 }}>
                  <button className="btn sec" onClick={askAI} disabled={busy}>{busy ? 'Thinking...' : 'Explain in plain English'}</button>
                  <label className="note"><input type="checkbox" checked={truth} onChange={(e) => setTruth(e.target.checked)} /> show simulator ground truth</label>
                </div>
                {explain && <div className="box" style={{ marginTop: 8 }}>{explain.text}<div className="note">Source: {explain.source}</div></div>}
                {truth && <div className="box" style={{ marginTop: 8 }}>Ground truth: {detail.truth.real ? `real fault (${detail.truth.mode}), fails at ${fmt(detail.truth.faultFailAt || 0)}` : 'no fault, this alert is noise'}</div>}
              </div>

              <div className="panel pad grid2">
                <Chart s={detail.series} title="Vibration" unit="mm/s" alarm={VIB_ALARM} color="#0FA3A3" />
                <Chart s={detail.series} title="Temperature" unit="deg C" alarm={TEMP_ALARM} color="#F2A33A" />
              </div>

              {r.diagnosis && r.resources && r.plan && r.comms && (
                <div className="grid2">
                  <div className="panel">
                    <h3>Diagnosis</h3>
                    <div className="pad">
                      <b>{r.diagnosis.mode}</b> <span className="muted">confidence {r.diagnosis.confidence.toFixed(2)}{r.diagnosis.confidence < 0.6 ? ' (preliminary, confirm on inspection)' : ''}</span>
                      <div className="note">Alternative: {r.diagnosis.alt}</div>
                      <p>{r.diagnosis.action}.</p>
                      {r.diagnosis.cite.map((c, k) => (
                        <div key={k} className="note" style={{ marginBottom: 4 }}>[{k + 1}] {c.doc}, {c.section}: {c.text} <a href={c.url} target="_blank" rel="noreferrer">source</a></div>
                      ))}
                      <div className="actions" style={{ marginTop: 8 }}>
                        <button className="btn pri" onClick={runAgent} disabled={agentBusy}>{agentBusy ? 'Agent investigating...' : 'Run agent workflow'}</button>
                      </div>
                      {agentErr && <div className="note" style={{ color: 'var(--red)', marginTop: 6 }}>{agentErr}</div>}
                      {agent && !agent.skipped && (
                        <div className="box" style={{ marginTop: 8 }}>
                          <div><b>{agent.final.mode}</b> <span className="muted">confidence {agent.final.confidence.toFixed(2)}</span> <span className="pill" style={{ marginLeft: 6 }}>{agent.source === 'llm' ? `LLM: ${agent.provider}` : 'rules only'}</span></div>
                          <p style={{ margin: '6px 0' }}>{agent.final.rationale}</p>
                          {agent.final.citations.map((c, k) => <div key={k} className="note">[{k + 1}] {c.doc}, {c.section}</div>)}
                          {agent.final.flags.map((f, k) => <div key={k} className="note" style={{ color: 'var(--red)' }}>Flag: {f}</div>)}
                          {agent.final.needsHuman && <div className="note"><b>Needs human review.</b></div>}
                          {agent.verifier?.ran && (
                            <div className="note">Verifier agent: {agent.verifier.approved === true ? 'approved' : agent.verifier.approved === false ? `concerns raised (${agent.verifier.concerns.join('; ')})` : 'no clear verdict'}{agent.verifier.revised ? ', diagnosis was sent back and revised once' : ''}.</div>
                          )}
                          {agent.comms && (
                            <div style={{ marginTop: 6 }}>
                              <div className="note"><b>Messages drafted by the {agent.comms.source === 'llm' ? 'Comms agent (checked against the plan)' : 'template'}</b>{agent.comms.note ? `. ${agent.comms.note}` : ''}</div>
                              <div className="note">Supervisor: {agent.comms.supervisor}</div>
                              <div className="note">Technician: {agent.comms.technician}</div>
                              <div className="note">Stores: {agent.comms.stores}</div>
                            </div>
                          )}
                          <div className="note" style={{ marginTop: 6 }}><b>Agent trace</b> ({agent.totalMs} ms, {agent.usage.calls} model calls, {agent.usage.prompt + agent.usage.completion} tokens)</div>
                          {agent.steps.map((st) => <div key={st.n} className="note">{st.n}. {st.kind === 'tool' ? `tool ${st.name}` : st.name} ({st.ms} ms): {st.summary}</div>)}
                          {agent.fallbackReason && <div className="note">Used the rule-based path: {agent.fallbackReason}</div>}
                          <div className="note">The agent proposes a diagnosis only. The verdict ({agent.verdict}), thresholds, stock check and schedule stay in plain code.</div>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="panel">
                    <h3>Constraint check</h3>
                    <div className="pad">
                      <table>
                        <thead><tr><th>Part</th><th>Qty</th><th>Stock</th></tr></thead>
                        <tbody>
                          {r.resources.parts.map((p) => (
                            <tr key={p.no}><td>{p.no}</td><td>{p.qty}</td><td className={p.inStock ? 'ok' : 'bad'}>{p.inStock ? 'In stock' : `Order, ETA ${Math.round(p.etaHours / 24)} d`}</td></tr>
                          ))}
                        </tbody>
                      </table>
                      <p style={{ marginBottom: 4 }}><b>Technician:</b> {r.plan.techName}{r.plan.callIn ? ' (call-in, slot is outside shift)' : ' (on shift)'}</p>
                      <p style={{ margin: 0 }}><b>Slot:</b> {fmt(r.plan.slotStart)} to {fmt(r.plan.slotEnd)} ({r.plan.type === 'immediate' ? 'immediate stop' : r.plan.type === 'sunday' ? 'Sunday full stop' : 'planned window'})</p>
                      {!r.plan.withinHorizon && <p className="bad" style={{ margin: '6px 0 0' }}>Slot is later than the {r.plan.horizonH} h risk horizon. Expedite parts or add a temporary mitigation.</p>}
                    </div>
                  </div>
                </div>
              )}

              {r.plan && r.comms && (
                <div className="panel">
                  <h3>Draft work order and messages</h3>
                  <div className="pad grid2">
                    <pre className="wo">{`${r.plan.workOrder.id}  ${r.plan.workOrder.priority}
${r.plan.workOrder.title}
Asset:  ${r.plan.workOrder.asset}
Window: ${r.plan.workOrder.start} to ${r.plan.workOrder.end}
Tech:   ${r.plan.workOrder.tech}
Parts:  ${r.plan.workOrder.parts.join('; ')}
Steps:
${r.plan.workOrder.steps.map((s, k) => ` ${k + 1}. ${s}`).join('\n')}`}</pre>
                    <div className="stack">
                      <div className="box"><b>Supervisor</b><div>{r.comms.supervisor}</div></div>
                      <div className="box"><b>Technician</b><div>{r.comms.technician}</div></div>
                      <div className="box"><b>Stores</b><div>{r.comms.stores}</div></div>
                    </div>
                  </div>
                </div>
              )}

              <div className="panel pad">
                <b>Supervisor decision</b>
                <div className="actions" style={{ marginTop: 8 }}>
                  {escalatable && <button className="btn pri" disabled={!!dec} onClick={() => logDecision(r.candidate.id, { action: 'Approved work order', at: new Date().toISOString() })}>Approve in one click</button>}
                  {!escalatable && <button className="btn sec" disabled={!!dec} onClick={() => logDecision(r.candidate.id, { action: 'Brought back for review', at: new Date().toISOString() })}>Bring back for review</button>}
                  <button className="btn dan" disabled={!!dec} onClick={() => logDecision(r.candidate.id, { action: 'Overridden by supervisor', at: new Date().toISOString() })}>Override verdict</button>
                  {dec && <span className="ok">{dec.action}{dec.note ? ` · ${dec.note}` : ''}</span>}
                </div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <span className="note">Technician logs outcome:</span>
                  <button className="btn sec" onClick={() => logOutcome(r.candidate.id, r.asset.id, 'confirmed')}>Fault confirmed</button>
                  <button className="btn sec" onClick={() => logOutcome(r.candidate.id, r.asset.id, 'no_fault')}>No fault found</button>
                  <button className="btn sec" onClick={() => logOutcome(r.candidate.id, r.asset.id, 'other')}>Other</button>
                  {outcomes[r.candidate.id] && <span className="note">Learning: {r.asset.id} threshold {r.adjudication.adj >= 0 ? '+' : ''}{r.adjudication.adj.toFixed(1)} z</span>}
                </div>
                <div className="note" style={{ marginTop: 6 }}>ReliaDesk never writes to a PLC or controls a machine. Every action here is a recommendation that a human approves.</div>
              </div>

              <div className="panel">
                <h3>Agent trace</h3>
                <div className="pad trace">
                  <div className="note" style={{ border: 0 }}>Orchestrator state machine, in order</div>
                  {r.trace.map((t, k) => (
                    <div key={k}>
                      <span className="ag">{t.agent}</span>
                      <span className={t.kind === 'loop' ? 'loop' : t.kind === 'skip' ? 'skip' : ''}>{t.kind === 'loop' ? 'LOOP BACK: ' : ''}{t.summary}</span>
                      <span className="note" style={{ marginLeft: 'auto' }}>{t.tool}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="panel">
            <h3>Audit log</h3>
            <div className="pad">
              {Object.keys(decisions).length === 0 && <span className="muted">No supervisor decisions yet.</span>}
              <table>
                <tbody>
                  {Object.entries(decisions).map(([id, d]) => (
                    <tr key={id}><td>{id}</td><td>{d.action}{d.note ? ` · ${d.note}` : ''}</td><td className="note">{d.at.slice(0, 19).replace('T', ' ')}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="actions" style={{ marginTop: 8 }}><button className="btn sec" onClick={reset}>Reset decisions and learning</button></div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
