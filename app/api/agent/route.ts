import { NextResponse } from 'next/server'
import { runAgent } from '@/lib/agentLoop'

export const dynamic = 'force-dynamic'
export const maxDuration = 45

// Best-effort limits per server instance. They protect the free provider quotas from a public URL.
const hits = new Map<string, number[]>()
let day = new Date().toDateString()
let dayCount = 0
const PER_MIN = 6
const DAILY_CAP = Number(process.env.AGENT_DAILY_CAP || 400)

function limited(ip: string) {
  const now = Date.now()
  if (new Date().toDateString() !== day) { day = new Date().toDateString(); dayCount = 0 }
  if (dayCount >= DAILY_CAP) return 'daily'
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000)
  if (arr.length >= PER_MIN) return 'minute'
  arr.push(now)
  hits.set(ip, arr)
  if (hits.size > 500) hits.clear()
  return ''
}

export async function POST(req: Request) {
  const text = await req.text()
  if (text.length > 30000) return NextResponse.json({ error: 'Request too large' }, { status: 413 })
  let body: { alertId?: unknown; outcomes?: unknown } = {}
  try { body = JSON.parse(text || '{}') } catch { /* empty */ }
  const id = typeof body.alertId === 'string' ? body.alertId : ''
  if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(id)) return NextResponse.json({ error: 'Bad alert id' }, { status: 400 })

  const ip = (req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim()
  const lim = limited(ip)
  if (lim) return NextResponse.json({ error: lim === 'daily' ? 'Daily demo limit reached, try again tomorrow.' : 'Too many requests, wait a minute.' }, { status: 429 })

  const outcomes = body.outcomes && typeof body.outcomes === 'object' ? (body.outcomes as Record<string, never>) : {}
  const out = await runAgent(id, outcomes)
  if (!out) return NextResponse.json({ error: 'Unknown alert' }, { status: 404 })
  if (out.source === 'llm') dayCount += 1
  return NextResponse.json(out)
}
