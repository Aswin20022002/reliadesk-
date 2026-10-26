const assert = require('assert')
const { getCandidates, runOne } = require('../.test-build/engine')
const { runAgent } = require('../.test-build/agentLoop')
const { chat, resetModelCache } = require('../.test-build/llm')
const { MODES } = require('../.test-build/kb')
const { fmt } = require('../.test-build/time')

const cand = getCandidates().find((c) => { const r = runOne(c.id, {}); return r && r.diagnosis })
const id = cand.id
const rule = runOne(id, {}).diagnosis
const cite = MODES[rule.mode].cite[0]
const otherMode = Object.keys(MODES).find((m) => m !== rule.mode)

const tc = (name, args) => ({ id: 'c_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const ok = (message) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) })
const final = (o) => ok({ role: 'assistant', content: '```json\n' + JSON.stringify(o) + '\n```' })
const script = (list) => { let i = 0; global.fetch = async () => { const x = list[Math.min(i++, list.length - 1)]; return typeof x === 'function' ? x() : x } }
const toolStep = (...calls) => ok({ role: 'assistant', content: null, tool_calls: calls })

;(async () => {
  // 1 no keys
  for (const k of ['GROQ_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','XAI_API_KEY']) delete process.env[k]
  let o = await runAgent(id, {})
  assert.equal(o.source, 'rules'); assert.equal(o.steps.length, 4); assert.equal(o.final.mode, rule.mode); assert.match(o.fallbackReason, /no free LLM key/)
  console.log('1 no keys -> rules ok')

  process.env.GROQ_API_KEY = 'test'
  const good = { mode: rule.mode, confidence: 0.82, rationale: 'Vibration and temperature rise match the stored signature.', citations: [{ doc: cite.doc, section: cite.section }], needs_human: false }
  // 2 success
  script([toolStep(tc('get_signal_evidence', {}), tc('list_failure_modes', {})), toolStep(tc('lookup_manual', { mode: rule.mode }), tc('check_parts', { mode: rule.mode })), final(good)])
  o = await runAgent(id, {})
  assert.equal(o.source, 'llm'); assert.equal(o.provider, 'groq'); assert.equal(o.final.citations.length, 1); assert.equal(o.final.agreesWithRules, true); assert.equal(o.final.needsHuman, false)
  assert.equal(o.steps.filter((s) => s.kind === 'tool').length, 4); assert.equal(o.usage.calls, 5) // 3 diagnosis + verifier + comms
  console.log('2 tool loop + grounded citation ok, steps:', o.steps.map((s) => s.name).join(' | '))

  // 3 hallucinated citation
  script([final({ ...good, citations: [{ doc: 'Made up manual', section: '9.9' }] })])
  o = await runAgent(id, {})
  assert.equal(o.final.citations.length, 0); assert.equal(o.final.needsHuman, true); assert.ok(o.final.flags.some((f) => /citation/.test(f)))
  console.log('3 hallucinated citation stripped and flagged ok')

  // 4 disagreement
  script([final({ ...good, mode: otherMode, citations: [{ doc: MODES[otherMode].cite[0].doc, section: MODES[otherMode].cite[0].section }] })])
  o = await runAgent(id, {})
  assert.equal(o.final.agreesWithRules, false); assert.equal(o.final.needsHuman, true); assert.equal(o.verdict, runOne(id, {}).adjudication.verdict)
  console.log('4 disagreement flagged, verdict untouched ok')

  // 5 invalid mode then valid
  script([final({ ...good, mode: 'Alien invasion' }), final(good)])
  o = await runAgent(id, {})
  assert.equal(o.source, 'llm'); assert.equal(o.final.mode, rule.mode)
  console.log('5 invalid mode rejected, retry accepted ok')

  // 6 never valid -> rules
  script([ok({ role: 'assistant', content: 'not json' })])
  o = await runAgent(id, {})
  assert.equal(o.source, 'rules'); assert.match(o.fallbackReason, /valid answer/)
  console.log('6 garbage output -> rules fallback ok')

  // 7 provider failover
  process.env.GEMINI_API_KEY = 'test'
  script([{ ok: false, status: 429, json: async () => ({}) }, final(good)])
  const r7 = await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(r7.provider, 'gemini'); assert.equal(r7.failed.length, 1); assert.match(r7.failed[0], /^groq\/.+: HTTP 429$/)
  console.log('7 groq 429 -> gemini failover ok')

  // 8 everything down
  script([() => { throw new Error('boom') }])
  o = await runAgent(id, {})
  assert.equal(o.source, 'rules'); assert.match(o.fallbackReason, /groq\/.+: network error; gemini\/.+: network error/)
  console.log('8 all providers down -> rules ok')

  // 9 tool budget + unknown tool do not crash
  script([toolStep(tc('delete_everything', {})), final(good)])
  o = await runAgent(id, {})
  assert.equal(o.source, 'llm'); assert.ok(o.steps.some((s) => /error/.test(s.summary)))
  console.log('9 unknown tool handled ok')

  // 10 non-diagnosis alert
  const nd = getCandidates().find((c) => !runOne(c.id, {}).diagnosis)
  o = await runAgent(nd.id, {})
  assert.ok(o.skipped)
  console.log('10 non-escalated alert skipped ok')

  // ---- multi-agent workflow: verifier loop-back and comms agent ----
  const full = runOne(id, {})
  const when = fmt(full.plan.slotStart)
  const partNos = full.resources.parts.map((p) => p.no)
  const goodComms = { supervisor: `Act now on ${full.asset.id}: repair planned ${when}. Approve to create the work order.`, technician: `${full.plan.techName}: please take ${full.asset.id} on ${when}.`, stores: `Please reserve ${partNos.join(', ')} for ${full.asset.id}.` }
  const approve = () => ok({ role: 'assistant', content: JSON.stringify({ approve: true, concerns: [] }) })
  const reject = (c) => ok({ role: 'assistant', content: JSON.stringify({ approve: false, concerns: [c] }) })
  const commsMsg = (o) => ok({ role: 'assistant', content: JSON.stringify(o) })

  script([final(good), approve(), commsMsg(goodComms)])
  o = await runAgent(id, {})
  assert.equal(o.verifier.approved, true); assert.equal(o.verifier.revised, false); assert.equal(o.comms.source, 'llm'); assert.equal(o.usage.calls, 3)
  console.log('11 verifier approves, comms agent draft passes checks ok')

  script([final(good), reject('temperature rise does not match'), final({ ...good, rationale: 'Revised after review: the temperature rise fits the stored signature.' }), approve(), commsMsg(goodComms)])
  o = await runAgent(id, {})
  assert.equal(o.verifier.revised, true); assert.equal(o.verifier.approved, true); assert.ok(o.steps.some((s) => s.name === 'Loop back')); assert.match(o.final.rationale, /Revised/)
  console.log('12 verifier sends diagnosis back, revised answer approved ok')

  script([final(good), reject('first concern'), final(good), reject('still wrong')])
  o = await runAgent(id, {})
  assert.equal(o.final.needsHuman, true); assert.ok(o.final.flags.some((f) => /verifier still has concerns/.test(f))); assert.equal(o.comms.source, 'template')
  console.log('13 verifier unconvinced after one revision -> human review, template comms ok')

  script([final(good), approve(), commsMsg({ ...goodComms, stores: `Reserve ZZZ-999 and ${partNos.join(', ')} for ${full.asset.id}.` })])
  o = await runAgent(id, {})
  assert.equal(o.comms.source, 'template'); assert.match(o.comms.note, /not in the plan/)
  console.log('14 comms draft with invented part number rejected, template used ok')

  script([final({ ...good, mode: otherMode, citations: [{ doc: MODES[otherMode].cite[0].doc, section: MODES[otherMode].cite[0].section }] }), approve()])
  o = await runAgent(id, {})
  assert.equal(o.comms.source, 'template'); assert.ok(o.comms.note)
  console.log('15 agent disagrees with rules -> comms stays on template until a human confirms ok')

  assert.ok(MODES[rule.mode].cite.every((c) => /^https:\/\//.test(c.url) && c.doc && c.section)); 
  console.log('16 every knowledge-base excerpt has a document, a page and a source link ok')

  // ---- model fallback inside one provider ----
  resetModelCache()
  delete process.env.GEMINI_API_KEY
  let calls17 = []
  global.fetch = async (u, o) => { const m = JSON.parse(o.body).model; calls17.push(m); return m === 'openai/gpt-oss-120b' ? { ok: false, status: 404, json: async () => ({}) } : ok({ role: 'assistant', content: 'hi' }) }
  const r17 = await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(r17.provider, 'groq'); assert.equal(r17.model, 'openai/gpt-oss-20b'); assert.match(r17.failed[0], /gpt-oss-120b: HTTP 404/)
  console.log('17 model returns 404 -> next model of the same provider used ok')

  calls17 = []
  await chat({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(calls17[0], 'openai/gpt-oss-20b'); assert.equal(calls17.length, 1)
  console.log('18 dead model remembered, not retried on the next call ok')

  resetModelCache()
  let bodies = []
  global.fetch = async (u, o) => { bodies.push(JSON.parse(o.body)); return ok({ role: 'assistant', content: 'hi' }) }
  await chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 300 })
  assert.equal(bodies[0].reasoning_effort, 'low'); assert.equal(bodies[0].max_tokens, 900)
  console.log('19 gpt-oss gets low reasoning effort and extra token headroom ok')

  resetModelCache()
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
  await assert.rejects(chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.failed.length === 1 && /HTTP 401/.test(e.failed[0]))
  console.log('20 bad key stops that provider after one attempt ok')
  resetModelCache()
  delete process.env.GROQ_API_KEY; process.env.GEMINI_API_KEY = 'test'
  let sent = null
  global.fetch = async (u, o) => { sent = JSON.parse(o.body); return ok({ role: 'assistant', content: 'hi' }) }
  await chat({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [tc('lookup_manual', { mode: 'a' })] }, { role: 'tool', tool_call_id: 'c_lookup_manual', content: '{}' }] })
  assert.equal(sent.messages[2].name, 'lookup_manual')
  console.log('21 gemini tool-result messages carry the function name ok')
  console.log('ALL PASSED')
})().catch((e) => { console.error('FAIL', e); process.exit(1) })
