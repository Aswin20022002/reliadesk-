'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fmt } from '@/lib/time'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Eval() {
  const [r, setR] = useState(0.6)
  const [ar, setAr] = useState(0.9)
  const [d, setD] = useState<any>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/eval?r=${r}&ar=${ar}`).then((x) => x.json()).then((j) => live && setD(j))
    return () => { live = false }
  }, [r, ar])

  const pct = (x: number) => `${Math.round(x * 100)}%`

  return (
    <>
      <div className="top">
        <h1>ReliaDesk</h1>
        <span className="tag">Replay evaluation · same 30 days, two systems</span>
        <nav>
          <Link href="/">Desk</Link>
          <Link href="/eval" className="on">Replay evaluation</Link>
        </nav>
      </div>
      <div style={{ padding: '16px 20px' }}>
        {!d && <div className="muted">Replaying 30 days...</div>}
        {d && (
          <>
            <div className="cards">
              <div className="card"><h4>False escalations cut</h4><div className="big">{pct(d.noise.falseCut)}</div><div className="note">{d.noise.staticFalse} false legacy alerts down to {d.noise.rdFalse} that still reach a human (case target 80%). {d.noise.rdFalse - d.noise.rdFalseNoHuman} of those are fail-open Watch cases.</div></div>
              <div className="card"><h4>Real faults caught 24 h or more before failure</h4><div className="big">{d.faults.detected} of {d.faults.total}</div><div className="note">Recall {pct(d.faults.recall)}. Missed-fault rate {pct(1 - d.faults.recall)}. Guardrail is 95%+.</div></div>
              <div className="card"><h4>Unplanned downtime cut</h4><div className="big">{pct(d.downtime.cut)}</div><div className="note">{d.downtime.statusQuoHrs.toFixed(0)} h expected today versus {d.downtime.reliadeskHrs.toFixed(0)} h with ReliaDesk (case target 30%). Depends on the two rates below.</div></div>
              <div className="card"><h4>Supervisor hours freed per week</h4><div className="big">{d.noise.freedHrsWeek.toFixed(0)}</div><div className="note">On this 40-asset replay plant, at 45 minutes per false escalation.</div></div>
            </div>

            <div className="panel pad" style={{ marginBottom: 14 }}>
              <b>Where the data comes from</b>
              <ul className="ev">
                <li><b>Real:</b> {d.data.realFaults} bearing-wear faults replay vibration run-to-failure curves measured on real bearings (NASA IMS bearing dataset, University of Cincinnati). Every asset also carries {d.data.noiseSamples} hourly samples of real healthy-bearing measurement noise from the same dataset.</li>
                <li><b>Simulated:</b> the plant around them (3 lines, 40 assets, shifts, start-ups, ambient heat), temperature, the other {d.data.simulatedFaults} faults (misalignment, lubrication starvation, imbalance), and the parts, roster and manuals. The IMS rig ran at constant load, so plant process variance is added on top.</li>
                <li><b>Not in the public data:</b> real plant alert logs with confirmed outcomes. The shadow-mode pilot and the Alert Audit are how those are obtained.</li>
                <li className="muted">Citation: {d.data.citation}</li>
                <li className="muted">Features via {d.data.featureSource}</li>
              </ul>
            </div>

            <div className="panel pad" style={{ marginBottom: 14 }}>
              <b>Assumptions you can change</b>
              <div className="actions" style={{ marginTop: 8 }}>
                <label>Status quo: supervisor acts on a real alert <b>{pct(r)}</b> of the time <input type="range" min="0.2" max="1" step="0.1" value={r} onChange={(e) => setR(+e.target.value)} /></label>
                <label>ReliaDesk: supervisor approves a correct recommendation <b>{pct(ar)}</b> of the time <input type="range" min="0.5" max="1" step="0.05" value={ar} onChange={(e) => setAr(+e.target.value)} /></label>
              </div>
              <div className="note" style={{ marginTop: 6 }}>Both rates are assumptions, not findings. The Alert Audit on a real plant measures them. Downtime cut at other settings:</div>
              <table style={{ marginTop: 6, maxWidth: 560 }}>
                <thead><tr><th>Status quo response</th><th>ReliaDesk approval</th><th>Downtime today</th><th>With ReliaDesk</th><th>Cut</th></tr></thead>
                <tbody>
                  {d.downtime.sensitivity.map((s: any, i: number) => (
                    <tr key={i}><td>{pct(s.r)}</td><td>{pct(s.ar)}</td><td>{s.sq.toFixed(0)} h</td><td>{s.rd.toFixed(0)} h</td><td><b>{pct(s.cut)}</b></td></tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="panel" style={{ marginBottom: 14 }}>
              <h3>Seeded faults: what each system did</h3>
              <div className="pad" style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr><th>Fault</th><th>Signal source</th><th>Asset</th><th>True mode</th><th>Fails at</th><th>Legacy first real alert (h before)</th><th>ReliaDesk first escalation (h before)</th><th>Parts ETA</th><th>Diagnosis at first alert</th><th>Diagnosis later</th><th>Prevented today</th><th>Prevented with ReliaDesk</th></tr>
                  </thead>
                  <tbody>
                    {d.faults.table.map((t: any) => (
                      <tr key={t.fault}>
                        <td>{t.fault}</td><td>{t.source}</td><td>{t.asset} {t.type}</td><td>{t.mode}</td><td>{fmt(t.failAt)}</td>
                        <td>{t.sqLead ?? 'none'}</td><td>{t.rdLead ?? 'none'}</td><td>{t.partsEtaDays ? `${t.partsEtaDays} d` : 'in stock'}</td>
                        <td className={t.modeCorrect ? 'ok' : 'bad'}>{t.rdMode ?? 'none'}</td>
                        <td className={t.latestCorrect ? 'ok' : 'bad'}>{t.latestMode ?? 'none'}</td>
                        <td className={t.sqFeasible ? 'ok' : 'bad'}>{t.sqFeasible ? 'if acted on' : 'no, parts too late'}</td>
                        <td className={t.rdFeasible ? 'ok' : 'bad'}>{t.rdFeasible ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="note" style={{ marginTop: 8 }}>
                  Diagnosis is correct on {pct(d.faults.diagnosisAccuracyFirst)} of faults at the first alert, when the signature is still faint, and on {pct(d.faults.diagnosisAccuracyLatest)} by the last alert 24 h or more before failure. Early diagnoses are flagged as preliminary on the desk.
                </div>
              </div>
            </div>

            <div className="panel pad">
              <b>Verdict mix across all {Object.values(d.noise.verdicts as Record<string, number>).reduce((a, b) => a + b, 0)} alerts</b>
              <div className="actions" style={{ marginTop: 6 }}>
                {Object.entries(d.noise.verdicts as Record<string, number>).map(([k, v]) => <span key={k} className="chipbtn">{k}: {v}</span>)}
              </div>
              <b style={{ display: 'block', marginTop: 12 }}>How to read this honestly</b>
              <ul className="ev">{d.assumptions.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
            </div>
          </>
        )}
      </div>
    </>
  )
}
