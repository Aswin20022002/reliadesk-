import { NextResponse } from 'next/server'
import { runOne } from '@/lib/engine'
import { fmt } from '@/lib/time'
import { chat, LLMUnavailable } from '@/lib/llm'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const r = runOne(body.alertId, body.outcomes || {})
  if (!r) return NextResponse.json({ error: 'Unknown alert' }, { status: 404 })

  const facts = {
    asset: `${r.asset.id} ${r.asset.type}`,
    time: fmt(r.candidate.hour),
    legacyTrigger: r.candidate.trigger,
    verdict: r.adjudication.verdict,
    confidence: +r.adjudication.confidence.toFixed(2),
    reason: r.adjudication.reason,
    evidence: r.adjudication.evidence,
    diagnosis: r.diagnosis ? { mode: r.diagnosis.mode, confidence: +r.diagnosis.confidence.toFixed(2), alternative: r.diagnosis.alt, action: r.diagnosis.action } : null,
    plan: r.plan ? { start: fmt(r.plan.slotStart), hours: r.plan.durationH, technician: r.plan.techName, callIn: r.plan.callIn, parts: r.resources?.parts.map((x) => `${x.no} ${x.inStock ? 'in stock' : 'ETA ' + Math.round(x.etaHours / 24) + ' days'}`) } : null,
  }

  const fallback = () => {
    const parts = [`${facts.verdict} for ${facts.asset} (confidence ${facts.confidence}). ${facts.reason}`]
    if (facts.diagnosis) parts.push(`Most likely cause: ${facts.diagnosis.mode} (confidence ${facts.diagnosis.confidence}), alternative ${facts.diagnosis.alternative}. Recommended action: ${facts.diagnosis.action}.`)
    if (facts.plan) parts.push(`Proposed slot ${facts.plan.start} for about ${facts.plan.hours} h with ${facts.plan.technician}${facts.plan.callIn ? ' (call-in)' : ''}.`)
    return parts.join(' ')
  }

  try {
    const res = await chat({
      maxTokens: 350,
      messages: [
        {
          role: 'system',
          content:
            'You are the reasoning layer of ReliaDesk, a maintenance decision desk. Using ONLY the JSON facts given, write a 3 to 5 sentence plain-English briefing for a shift maintenance supervisor: the verdict, the strongest evidence, the likely cause and the proposed action. Do not invent numbers, parts or manuals. Do not use em dashes. If confidence is low, say a human should check.',
        },
        { role: 'user', content: JSON.stringify(facts) },
      ],
    })
    const text = (res.message.content || '').replace(/\u2014|\u2013/g, ',').trim()
    if (!text) throw new Error('empty')
    return NextResponse.json({ text, source: `llm (${res.provider}, ${res.model})` })
  } catch (e) {
    const none = e instanceof LLMUnavailable && !e.failed.length
    return NextResponse.json({ text: fallback(), source: none ? 'rules (no free LLM key set)' : 'rules (LLM unavailable)' })
  }
}
