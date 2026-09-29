/** Runs a probe against the serving server (SPEC §3.9); the renderer has no network, so it runs here. */
import type { DoneEvent, LogLine } from '@shared/events'
import { matchDone, takeSseData, type ProbeRequest, type ProbeResult } from '@shared/probe'
import type { ProcessManager } from './ProcessManager'

interface Chunk {
  error?: { message?: string }
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; message?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function runProbe(
  target: { base: string; model: string; manager: ProcessManager },
  req: ProbeRequest,
  options: { timeoutMs?: number; matchWaitMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const label = req.label ?? 'probe'
  const done: Array<{ at: number; event: DoneEvent }> = []
  const onLines = (lines: LogLine[]): void => {
    for (const l of lines) if (l.event.kind === 'done' && !l.event.background) done.push({ at: l.at, event: l.event })
  }
  target.manager.on('lines', onLines)
  const startedAt = Date.now()
  const t0 = performance.now()
  const result: ProbeResult = {
    label,
    ok: false,
    error: null,
    status: null,
    startedAt,
    totalS: 0,
    ttftS: null,
    promptTokens: null,
    completionTokens: null,
    tokPerS: null,
    finish: null,
    server: null,
    replyPreview: ''
  }
  try {
    const body = {
      model: target.model,
      messages: [{ role: 'user', content: req.prompt }],
      max_tokens: req.maxTokens,
      stream: req.stream,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      ...(req.stream ? { stream_options: { include_usage: true } } : {})
    }
    const res = await fetchImpl(`${target.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000)
    })
    result.status = res.status
    if (!res.ok) {
      const text = await res.text()
      let message = text
      try {
        message = (JSON.parse(text) as Chunk).error?.message ?? text
      } catch {
        // not JSON
      }
      result.error = `HTTP ${res.status}: ${message}`
      return result
    }
    let deltas = 0
    let firstAt: number | null = null
    let preview = ''
    const note = (text: string | undefined): void => {
      if (!text) return
      deltas++
      firstAt ??= performance.now()
      if (preview.length < 600) preview += text
    }
    if (req.stream && res.body) {
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true })
        const { data, rest } = takeSseData(buffer)
        buffer = rest
        for (const payload of data) {
          if (payload === '[DONE]') continue
          const chunk = JSON.parse(payload) as Chunk
          if (chunk.error) result.error = chunk.error.message ?? 'the stream carried an error'
          const choice = chunk.choices?.[0]
          note(choice?.delta?.reasoning_content)
          note(choice?.delta?.content)
          if (choice?.finish_reason) result.finish = choice.finish_reason
          if (chunk.usage) {
            result.promptTokens = chunk.usage.prompt_tokens ?? null
            result.completionTokens = chunk.usage.completion_tokens ?? null
          }
        }
      }
      result.completionTokens ??= deltas
    } else {
      const chunk = (await res.json()) as Chunk
      const choice = chunk.choices?.[0]
      preview = `${choice?.message?.reasoning_content ?? ''}${choice?.message?.content ?? ''}`.slice(0, 600)
      result.finish = choice?.finish_reason ?? null
      result.promptTokens = chunk.usage?.prompt_tokens ?? null
      result.completionTokens = chunk.usage?.completion_tokens ?? null
    }
    const t1 = performance.now()
    result.totalS = (t1 - t0) / 1000
    result.replyPreview = preview
    if (req.stream && firstAt !== null) {
      result.ttftS = (firstAt - t0) / 1000
      const decodeS = (t1 - firstAt) / 1000
      const tokens = result.completionTokens ?? deltas
      result.tokPerS = decodeS > 0 && tokens > 1 ? (tokens - 1) / decodeS : null
    } else if (result.completionTokens) {
      result.tokPerS = result.completionTokens / result.totalS
    }
    result.ok = result.error === null
    const deadline = Date.now() + (options.matchWaitMs ?? 5000)
    while (Date.now() < deadline) {
      result.server = matchDone(done, startedAt, result.promptTokens, result.completionTokens)
      if (result.server) break
      await new Promise((r) => setTimeout(r, 100))
    }
    return result
  } catch (e) {
    result.error = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
    return result
  } finally {
    result.totalS ||= (performance.now() - t0) / 1000
    target.manager.off('lines', onLines)
  }
}
