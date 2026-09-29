/**
 * The probe (SPEC §3.9): one chat completion, measured by the app, beside the server's own `done` line for
 * the same request. A measuring tool, not a chat client.
 */
import type { ReasoningEffort } from './config'
import type { DoneEvent } from './events'

export interface ProbeRequest {
  prompt: string
  maxTokens: number
  reasoningEffort: ReasoningEffort | null
  stream: boolean
  label?: string
}

export interface ProbeResult {
  label: string
  ok: boolean
  /** The server's message on a refusal (HTTP 400 carries the window check's text, which the log does not keep). */
  error: string | null
  status: number | null
  startedAt: number
  totalS: number
  /** First content or reasoning delta; streaming only. */
  ttftS: number | null
  promptTokens: number | null
  completionTokens: number | null
  /** Streaming: (tokens − 1) over the time after the first token. Otherwise tokens over the whole request. */
  tokPerS: number | null
  finish: string | null
  /** The `done` line of this request, matched by prompt and reply token counts. */
  server: DoneEvent | null
  replyPreview: string
}

/** Splits a server-sent-event buffer into `data:` payloads, keeping an unfinished line for later. */
export function takeSseData(buffer: string): { data: string[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const data = lines.map((l) => l.replace(/\r$/, '')).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  return { data, rest }
}

/** The done line for a finished request: same prompt and reply tokens, printed after it started. */
export function matchDone(candidates: Array<{ at: number; event: DoneEvent }>, startedAt: number, promptTokens: number | null, completionTokens: number | null): DoneEvent | null {
  const after = candidates.filter((c) => c.at >= startedAt - 50)
  const exact = after.find((c) => (promptTokens === null || c.event.prompt === promptTokens) && (completionTokens === null || c.event.tokens === completionTokens))
  return exact?.event ?? null
}
