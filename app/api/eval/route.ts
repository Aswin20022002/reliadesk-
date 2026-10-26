import { NextResponse } from 'next/server'
import { evaluate } from '@/lib/engine'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const u = new URL(req.url)
  const r = Math.min(1, Math.max(0, Number(u.searchParams.get('r') ?? 0.6)))
  const ar = Math.min(1, Math.max(0, Number(u.searchParams.get('ar') ?? 0.9)))
  return NextResponse.json(evaluate(r, ar))
}
