# ReliaDesk MVP

An agentic reliability desk that turns noisy factory sensor alerts into a verdict, a plan and a one-click approval. Built for Abhikalp 2026, Case 11 (Manufacturing and Industrial Automation).

Stack: Next.js 14 (App Router, TypeScript) on Vercel. No database and no API key are needed to run it. Optional free LLM keys (Groq, Google Gemini, OpenRouter, xAI) switch on the tool-calling agent workflow and the plain-English briefing.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

## Deploy on Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, choose Add New Project, import the repo, keep the defaults (framework: Next.js), and deploy.
3. Optional: add `GROQ_API_KEY` and `GEMINI_API_KEY` (both free, see `.env.example`) in Project Settings, then redeploy. Without any key the desk, the replay and the agent trace still work, using the rule-based path.

## What is in the app

- **Desk (`/`)**: the alert queue, each alert with a verdict (Act now, Plan in window, Watch, Suppress), the evidence, charts against the legacy fixed threshold, diagnosis with citations, a parts and technician check, a planned slot, a drafted work order and three drafted messages. The supervisor approves, overrides or brings back. The technician logs an outcome, which changes that asset's alert threshold. Everything is recorded in an audit log. The agent trace shows the orchestrator, including loop-backs when evidence is missing. "Run agent workflow" runs the Diagnosis, Verifier and Comms agents described below.
- **Replay evaluation (`/eval`)**: replays the same 30 days through the legacy static thresholds and through ReliaDesk, and reports false-escalation cut, missed-fault rate, diagnosis accuracy and the effect on unplanned downtime. Two assumptions are sliders, because they are assumptions.

## How it maps to the slides

| Slide claim | Where in the code |
| --- | --- |
| Replay plant: 3 lines, about 40 assets, 30 days, 10 seeded faults (4 bearing faults use real IMS curves) | `lib/plant.ts`, `lib/imsData.ts` |
| Eight agents with tools | `lib/agents.ts` (Signal, Context, Adjudicator, Diagnosis, Resource, Planner, Comms, plus the learning loop through `assetAdj`) |
| Orchestrator that loops back when evidence is missing | `runPipeline` in `lib/agents.ts` |
| Mocked CMMS and SAP, roster | `lib/kb.ts` (synthetic stock, roster and part numbers, clearly labelled) |
| Manual excerpts with citations | `lib/kb.ts` (paraphrased from two real public references, with pages and links) |
| Evaluation harness | `evaluate` in `lib/engine.ts` |
| Language model with a rule-based fallback | `lib/llm.ts`, `lib/agentLoop.ts`, `app/api/agent/route.ts`, `app/api/explain/route.ts` |
| Never writes to a PLC | No write path exists. Every action is a recommendation. |

## AI layer: a multi-agent workflow on free providers

"Run agent workflow" on an escalated alert runs three cooperating agents, with plain code owning every safety-critical step:

1. **Diagnosis agent** (tool-calling LLM). Calls `get_signal_evidence`, `list_failure_modes`, `lookup_manual`, `check_parts` and `reference_bearing_frequencies`, then proposes a failure mode with citations.
2. **Verifier agent** (independent second model call). Checks the proposal against the measured evidence and the cited excerpts. If it raises concerns, the orchestrator loops back and the Diagnosis agent revises once. If concerns remain, the case is flagged for a human.
3. **Comms agent** (LLM). Drafts the supervisor, technician and stores messages. Code then checks every message against the plan (asset, slot, technician name, every part number, no invented part numbers). A draft that fails is replaced by the template.

Guardrails, enforced in `lib/agentLoop.ts` and covered by `npm run test:agent` (16 scenarios against a mocked provider):
- Agents propose only. The verdict, thresholds, stock check and schedule stay in plain code.
- The failure mode must exist in the knowledge base, and every citation must match a real knowledge-base excerpt. Ungrounded citations are removed and the case is flagged.
- If the agent disagrees with the rule-based diagnosis, the case is flagged for human review and the messages stay on the template.
- Tool and iteration budgets are capped, and any failure falls back to the rule-based path, so a provider outage never breaks the desk.
- The agents never see simulator ground truth.

Providers (set any key, no card needed, see `.env.example`): Groq, Google AI Studio (Gemini), OpenRouter free models, xAI Grok (promotional credits only). They are tried in the order of `LLM_CHAIN`. Free tiers change without notice, so check the model names in `.env.example` against each provider's console.

`/api/agent` is rate limited per instance and capped per day to protect the free quotas on a public URL.

## Knowledge base references

The diagnosis excerpts are short paraphrases of two real public documents, shown with page numbers and links in the UI:
- NASA Kennedy Space Center, Preferred Practices, Technique AT-8, "Vibration Analysis of Rotating Ground Support Machinery", pp. AT-47 to AT-50.
- M. Woodard and M. Wolka (NSK Corporation), "Bearing Maintenance Practices to Ensure Maximum Life", Proceedings of the 27th International Pump Users Symposium, Texas A&M Turbomachinery Laboratory, 2011, pp. 80 to 96.

They support the qualitative symptoms and remedies. The numeric failure signatures, part numbers, repair hours and repair steps are model parameters for this demo, not taken from those documents. A plant would load its own OEM manuals, FMEA register and CMMS history.

## Data sources

| Part of the replay | Source |
| --- | --- |
| Bearing-wear fault curves (4 of 10 faults) | Real vibration run-to-failure records from the NASA IMS bearing dataset (Set 1 bearings 3 and 4, Set 2 bearing 1, Set 3 bearing 3). Each is the measured RMS ratio against that bearing's own healthy baseline, replayed over the fault window. |
| Measurement noise on every asset | Real healthy-bearing RMS deviations from the same dataset (Sets 1 to 3), 897 hourly samples. |
| Plant context (lines, load, start-ups, ambient heat), temperature, misalignment, lubrication and imbalance faults | Simulated, fixed seed. The IMS rig ran at constant load and has no temperature channel, so these cannot come from it. |
| Manual excerpts | Paraphrased from NASA KSC AT-8 and Woodard and Wolka (NSK, Texas A&M 2011), with pages and links. |
| Stock, roster, part numbers, CMMS history | Synthetic and labelled so in the code. |

Citation: J. Lee, H. Qiu, G. Yu, J. Lin, Rexnord Technical Services (2007). IMS, University of Cincinnati. "Bearing Data Set", NASA Prognostics Data Repository, NASA Ames Research Center.

The RMS features are taken from `data/processed/test{1,2,3}_raw.csv` in github.com/fatemeh-studio/nasa-bearing-anomaly (MIT licence), computed there from the original 20 kHz records. `lib/imsData.ts` is generated from them by `scripts/build_ims_data.py`; the script header has the two commands to regenerate it. See `DATA_SOURCES.md` for details and limits.

## Honest limits (say these before a judge asks)

- Only the bearing-wear signatures and the sensor noise are real measurements. The plant, the other fault modes and the temperature are simulated. Replay results show the logic works on a plant we designed, fed partly with real bearing data, not on a real plant.
- Real bearing faults are hard: in the IMS data the rise is often sudden, for example a fault that stays near baseline until about a day before failure. The replay reports misses as they are, so the missed-fault rate can sit below the 95% guardrail.
- Stock levels, the roster, part numbers and repair hours are synthetic demo content. The manual excerpts are paraphrased from two real public references (see above). Bearing defect frequencies in the agent tool are computed from the published geometry of the IMS test bearing and apply to that rig only.
- The LLM agent was tested against a mocked provider in `npm run test:agent`. Live free-tier behaviour depends on the provider and model you configure.
- In a plant, stock, roster, part numbers and repair procedures come from SAP, the roster system, OEM manuals and the FMEA register.
- The suppress, watch and escalate decisions are deterministic rules by design. Language models only propose a diagnosis, check it and draft messages, and only when a free LLM key is configured. Without a key the whole desk runs on rules.
- Baselines need history: the first 7 days are a learning period, and a repaired asset relearns its baseline. Until then the desk fails open to a human.
- Diagnosis is less certain at the first alert and improves as evidence builds. Early diagnoses are flagged as preliminary.
- Downtime results depend on two assumed rates (supervisor response today, supervisor approval with ReliaDesk). The Alert Audit is how we measure them on a real plant.
- Outcomes and decisions live in the browser (localStorage). A shared database (Supabase) is the next step.

## Next steps

1. Supabase for shared decisions, outcomes and the audit log.
2. Case deduplication, so repeated alerts on one asset become one open case.
3. Retrieval over a plant's own uploaded OEM manuals and FMEA register, replacing the two public references.
4. CSV upload of a plant's own alert export, for the Alert Audit.
