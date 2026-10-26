import { NextResponse } from 'next/server'
import { summarize } from '@/lib/engine'
import { getPlant, LEARN_H } from '@/lib/plant'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const items = summarize(body.outcomes || {})
  const p = getPlant()
  return NextResponse.json({
    items,
    lines: p.lines.map((l) => ({ id: l.id, name: l.name })),
    assets: p.assets.length,
    learnHours: LEARN_H,
  })
}
