// One OpenAI-compatible client over several FREE providers, tried in order.
// Groq, Google Gemini (AI Studio), OpenRouter free models and xAI Grok all speak the same
// /chat/completions protocol with tool calling, so a failure or rate limit on one provider
// falls through to the next, and finally to the rule-based path in the caller.

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface Provider { id: string; base: string; key: string; models: string[] }
export interface ChatResult {
  provider: string
  model: string
  message: Msg
  usage: { prompt: number; completion: number }
  ms: number
  failed: string[] // providers tried before this one, with the reason (no secrets)
}

const env = (k: string) => (process.env[k] || '').trim()
const list = (k: string, fallback: string) => (env(k) || fallback).split(',').map((x) => x.trim()).filter(Boolean)

// Free-tier model catalogs change often. Each provider gets an ordered list; a model that returns
// "not found" or a server error is skipped, and remembered as dead for a few minutes.
// Override with GROQ_MODEL, GEMINI_MODEL, OPENROUTER_MODEL or XAI_MODEL (comma separated).
export function providers(): Provider[] {
  const defs: Record<string, () => Provider | null> = {
    groq: () => env('GROQ_API_KEY') ? { id: 'groq', base: 'https://api.groq.com/openai/v1', key: env('GROQ_API_KEY'), models: list('GROQ_MODEL', 'openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile') } : null,
    gemini: () => env('GEMINI_API_KEY') ? { id: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: env('GEMINI_API_KEY'), models: list('GEMINI_MODEL', 'gemini-flash-latest,gemini-flash-lite-latest') } : null,
    openrouter: () => env('OPENROUTER_API_KEY') ? { id: 'openrouter', base: 'https://openrouter.ai/api/v1', key: env('OPENROUTER_API_KEY'), models: list('OPENROUTER_MODEL', 'meta-llama/llama-3.3-70b-instruct:free,openai/gpt-oss-20b:free') } : null,
    xai: () => env('XAI_API_KEY') ? { id: 'xai', base: 'https://api.x.ai/v1', key: env('XAI_API_KEY'), models: list('XAI_MODEL', 'grok-4.3') } : null,
  }
  return (env('LLM_CHAIN') || 'groq,gemini,openrouter,xai')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => defs[id]?.() || null)
    .filter((x): x is Provider => !!x)
}

const dead = new Map<string, number>() // "provider/model" -> time until which it is skipped
const DEAD_MS = 10 * 60 * 1000
export function resetModelCache() { dead.clear() }

// Gemini's OpenAI-compatible endpoint expects the function name on tool-result messages.
function forProvider(p: Provider, messages: Msg[]): unknown[] {
  if (p.id !== 'gemini') return messages
  const names = new Map<string, string>()
  for (const m of messages) for (const c of m.tool_calls || []) names.set(c.id, c.function.name)
  return messages.map((m) => (m.role === 'tool' && m.tool_call_id ? { ...m, name: names.get(m.tool_call_id) || 'tool' } : m))
}

export class LLMUnavailable extends Error {
  failed: string[]
  constructor(failed: string[]) {
    super(failed.length ? 'All LLM providers failed' : 'No LLM provider configured')
    this.failed = failed
  }
}

export async function chat(opts: { messages: Msg[]; tools?: ToolDef[]; maxTokens?: number; timeoutMs?: number }): Promise<ChatResult> {
  const failed: string[] = []
  for (const p of providers()) {
    for (const model of p.models) {
      const label = `${p.id}/${model}`
      if ((dead.get(label) || 0) > Date.now()) continue
      const t0 = Date.now()
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000)
      try {
        const gptOss = model.startsWith('openai/gpt-oss')
        const body: Record<string, unknown> = { model, messages: forProvider(p, opts.messages), temperature: 0.1, max_tokens: (opts.maxTokens ?? 500) + (gptOss ? 600 : 0) }
        if (gptOss) body.reasoning_effort = 'low' // keeps hidden reasoning from eating the answer budget
        if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto' }
        const resp = await fetch(`${p.base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
          body: JSON.stringify(body),
          signal: ctl.signal,
        })
        if (!resp.ok) {
          failed.push(`${label}: HTTP ${resp.status}`)
          if (resp.status === 401 || resp.status === 403 || resp.status === 429) break // key or quota problem, next provider
          if (resp.status === 404 || resp.status === 400) dead.set(label, Date.now() + DEAD_MS) // model not available
          continue // try the next model of this provider
        }
        const data = await resp.json()
        const m = data?.choices?.[0]?.message
        if (!m) { failed.push(`${label}: empty response`); continue }
        return {
          provider: p.id,
          model,
          message: { role: 'assistant', content: m.content ?? null, tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : undefined },
          usage: { prompt: data?.usage?.prompt_tokens ?? 0, completion: data?.usage?.completion_tokens ?? 0 },
          ms: Date.now() - t0,
          failed,
        }
      } catch (e) {
        failed.push(`${label}: ${(e as Error).name === 'AbortError' ? 'timeout' : 'network error'}`)
        break // timeouts and network errors are not model specific, next provider
      } finally {
        clearTimeout(timer)
      }
    }
  }
  throw new LLMUnavailable(failed)
}
