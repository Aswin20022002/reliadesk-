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
export interface Provider { id: string; base: string; key: string; model: string }
export interface ChatResult {
  provider: string
  model: string
  message: Msg
  usage: { prompt: number; completion: number }
  ms: number
  failed: string[] // providers tried before this one, with the reason (no secrets)
}

const env = (k: string) => (process.env[k] || '').trim()

export function providers(): Provider[] {
  const defs: Record<string, () => Provider | null> = {
    groq: () => env('GROQ_API_KEY') ? { id: 'groq', base: 'https://api.groq.com/openai/v1', key: env('GROQ_API_KEY'), model: env('GROQ_MODEL') || 'llama-3.3-70b-versatile' } : null,
    gemini: () => env('GEMINI_API_KEY') ? { id: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL') || 'gemini-flash-latest' } : null,
    openrouter: () => env('OPENROUTER_API_KEY') ? { id: 'openrouter', base: 'https://openrouter.ai/api/v1', key: env('OPENROUTER_API_KEY'), model: env('OPENROUTER_MODEL') || 'meta-llama/llama-3.3-70b-instruct:free' } : null,
    xai: () => env('XAI_API_KEY') ? { id: 'xai', base: 'https://api.x.ai/v1', key: env('XAI_API_KEY'), model: env('XAI_MODEL') || 'grok-4.3' } : null,
  }
  return (env('LLM_CHAIN') || 'groq,gemini,openrouter,xai')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => defs[id]?.() || null)
    .filter((x): x is Provider => !!x)
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
    const t0 = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000)
    try {
      const body: Record<string, unknown> = { model: p.model, messages: opts.messages, temperature: 0.1, max_tokens: opts.maxTokens ?? 500 }
      if (opts.tools?.length) { body.tools = opts.tools; body.tool_choice = 'auto' }
      const resp = await fetch(`${p.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      if (!resp.ok) { failed.push(`${p.id}: HTTP ${resp.status}`); continue }
      const data = await resp.json()
      const m = data?.choices?.[0]?.message
      if (!m) { failed.push(`${p.id}: empty response`); continue }
      return {
        provider: p.id,
        model: p.model,
        message: { role: 'assistant', content: m.content ?? null, tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : undefined },
        usage: { prompt: data?.usage?.prompt_tokens ?? 0, completion: data?.usage?.completion_tokens ?? 0 },
        ms: Date.now() - t0,
        failed,
      }
    } catch (e) {
      failed.push(`${p.id}: ${(e as Error).name === 'AbortError' ? 'timeout' : 'network error'}`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new LLMUnavailable(failed)
}
