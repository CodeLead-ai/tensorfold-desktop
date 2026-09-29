/**
 * The request feed (SPEC §3.4): rows from the log's `done` and `start failed` lines, plus the two kinds of
 * failures the log shows without a request id (HTTP errors on chat completions, and `request error`), and
 * the session's totals.
 */
import type { DoneEvent, LogLine, RefusedEvent } from './events'

export type RequestRow =
  | { kind: 'done'; seq: number; at: number; event: DoneEvent }
  /** Admission refused it before prefill (a `start failed` line). */
  | { kind: 'refused'; seq: number; at: number; event: RefusedEvent }
  /** A chat completion answered with an HTTP error: the window check (400) or a server error (500). */
  | { kind: 'http'; seq: number; at: number; status: number; method: string; path: string }
  /** `request error: …` or `stream error: …`. */
  | { kind: 'error'; seq: number; at: number; what: string; errorType: string | null; message: string }

export function rowFromLine(line: LogLine): RequestRow | null {
  const e = line.event
  switch (e.kind) {
    case 'done':
      return e.background ? null : { kind: 'done', seq: line.seq, at: line.at, event: e }
    case 'refused':
      return { kind: 'refused', seq: line.seq, at: line.at, event: e }
    case 'access':
      return e.status >= 400 && e.path.endsWith('/completions')
        ? { kind: 'http', seq: line.seq, at: line.at, status: e.status, method: e.method, path: e.path }
        : null
    case 'error':
      return e.what === 'request' || e.what === 'stream'
        ? { kind: 'error', seq: line.seq, at: line.at, what: e.what, errorType: e.errorType, message: e.message }
        : null
    default:
      return null
  }
}

/** Prompt tokens actually prefilled per second: (prompt − cached) / prefill. */
export function prefillRate(e: DoneEvent): number | null {
  const fresh = e.prompt - e.cached
  if (e.prefillS === null || e.prefillS <= 0 || fresh <= 0) return null
  return fresh / e.prefillS
}

export function acceptanceRatio(e: DoneEvent): number | null {
  return e.accepted.proposed > 0 ? e.accepted.accepted / e.accepted.proposed : null
}

export interface RequestTotals {
  requests: number
  refused: number
  failed: number
  tokensIn: number
  cachedIn: number
  tokensOut: number
  /** Mean of the requests' tok/s. */
  meanTokPerS: number | null
  /** All reply tokens over all decode time. */
  weightedTokPerS: number | null
  /** All prefilled tokens over all prefill time. */
  prefillRate: number | null
  /** All accepted drafts over all proposed. */
  acceptance: number | null
  /** The prefix cache as the latest done line reports it (its counters are the server's running totals). */
  cache: DoneEvent['checkpoints']
  lastTokPerS: number | null
}

export function summarize(rows: readonly RequestRow[]): RequestTotals {
  let requests = 0
  let refused = 0
  let failed = 0
  let tokensIn = 0
  let cachedIn = 0
  let tokensOut = 0
  let tokPerSSum = 0
  let decodeSeconds = 0
  let decodedTokens = 0
  let fresh = 0
  let prefillSeconds = 0
  let accepted = 0
  let proposed = 0
  let cache: DoneEvent['checkpoints'] = null
  let lastTokPerS: number | null = null
  for (const row of rows) {
    if (row.kind === 'refused') {
      refused++
      continue
    }
    if (row.kind !== 'done') {
      failed++
      continue
    }
    const e = row.event
    requests++
    tokensIn += e.prompt
    cachedIn += e.cached
    tokensOut += e.tokens
    tokPerSSum += e.tokPerS
    if (e.tokPerS > 0) {
      decodeSeconds += e.tokens / e.tokPerS
      decodedTokens += e.tokens
    }
    if (prefillRate(e) !== null) {
      fresh += e.prompt - e.cached
      prefillSeconds += e.prefillS as number
    }
    accepted += e.accepted.accepted
    proposed += e.accepted.proposed
    if (e.checkpoints) cache = e.checkpoints
    lastTokPerS = e.tokPerS
  }
  return {
    requests,
    refused,
    failed,
    tokensIn,
    cachedIn,
    tokensOut,
    meanTokPerS: requests > 0 ? tokPerSSum / requests : null,
    weightedTokPerS: decodeSeconds > 0 ? decodedTokens / decodeSeconds : null,
    prefillRate: prefillSeconds > 0 ? fresh / prefillSeconds : null,
    acceptance: proposed > 0 ? accepted / proposed : null,
    cache,
    lastTokPerS
  }
}

/** tok/s of the last `n` completed requests, oldest first (the sparkline). */
export function tokPerSSeries(rows: readonly RequestRow[], n = 60): number[] {
  const out: number[] = []
  for (let i = rows.length - 1; i >= 0 && out.length < n; i--) {
    const row = rows[i] as RequestRow
    if (row.kind === 'done') out.push(row.event.tokPerS)
  }
  return out.reverse()
}
