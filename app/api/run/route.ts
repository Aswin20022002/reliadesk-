import { NextResponse } from 'next/server'
import { runOne, seriesWindow } from '@/lib/engine'
import { getPlant } from '@/lib/plant'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const r = runOne(body.alertId, body.outcomes || {})
  if (!r) return NextResponse.json({ error: 'Unknown alert' }, { status: 404 })
  const fault = getPlant().faults.find((f) => f.assetId === r.asset.id)
  return NextResponse.json({
    result: r,
    series: seriesWindow(r.asset.id, r.candidate.hour),
    truth: { ...r.candidate.truth, faultFailAt: fault?.failAt },
  })
}
