import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DoneEvent, LogLine } from '@shared/events'
import { acceptanceRatio, prefillRate, rowFromLine, summarize, tokPerSSeries, type RequestRow } from '@shared/requests'
import { parseLine } from '../../src/main/LogParser'

function rowsOf(file: string): RequestRow[] {
  const texts = readFileSync(join(__dirname, '..', 'fixtures', file), 'utf8').split('\n').filter(Boolean)
  const lines: LogLine[] = texts.map((text, i) => ({ seq: i + 1, at: 1000 + i, stream: 'stdout', text, event: parseLine(text) }))
  return lines.map(rowFromLine).filter((r): r is RequestRow => r !== null)
}

describe('request rows', () => {
  it('makes a row of each done and refused line of Appendix A', () => {
    const rows = rowsOf('serve-log-2026-09-29.txt')
    expect(rows.map((r) => r.kind)).toEqual(['done', 'done', 'refused'])
    const refusal = rows[2]
    expect(refusal?.kind === 'refused' && refusal.event.replyTokens).toBe(64000)
  })

  it('computes the prefill rate from the tokens actually prefilled', () => {
    const rows = rowsOf('k3-serve-2026-09-29.txt')
    const resumed = rows.find((r) => r.kind === 'done' && r.event.reqId === 'req-3c005e316298')
    expect(resumed?.kind === 'done' && prefillRate(resumed.event)).toBeCloseTo(5 / 0.18, 6)
    const cold = rows.find((r) => r.kind === 'done' && r.event.reqId === 'req-07bcd37c1ff7')
    expect(cold?.kind === 'done' && prefillRate(cold.event)).toBeCloseTo(23124 / 41.71, 6)
    expect(cold?.kind === 'done' && acceptanceRatio(cold.event)).toBeCloseTo(3824 / 12792, 9)
  })

  it('turns failed chat completions into rows, and nothing else', () => {
    const at = (text: string): RequestRow | null => rowFromLine({ seq: 1, at: 1, stream: 'stdout', text, event: parseLine(text) })
    expect(at('[tensorfold] 127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 400 -')).toMatchObject({ kind: 'http', status: 400 })
    expect(at('[tensorfold] 127.0.0.1 "GET /metrics HTTP/1.1" 404 -')).toBeNull()
    expect(at('[tensorfold] request error: RuntimeError: boom')).toMatchObject({ kind: 'error', errorType: 'RuntimeError', message: 'boom' })
    expect(at('[tensorfold] done warm-1 prompt=640 cached=0 thinking=True effort=medium tokens=1 sha=x finish=length tok/s=0.0 ttft=-1.00s prefill=-1.00s background preemptions=0 rounds=0 accepted=0/0 checkpoints=off')).toBeNull()
  })
})

describe('session totals', () => {
  it('adds up the K3 run', () => {
    const rows = rowsOf('k3-serve-2026-09-29.txt')
    const done = rows.filter((r): r is Extract<RequestRow, { kind: 'done' }> => r.kind === 'done').map((r) => r.event as DoneEvent)
    const t = summarize(rows)
    expect(t.requests).toBe(52)
    expect(t.refused).toBe(1)
    expect(t.tokensIn).toBe(done.reduce((s, e) => s + e.prompt, 0))
    expect(t.tokensOut).toBe(done.reduce((s, e) => s + e.tokens, 0))
    expect(t.cachedIn).toBe(done.reduce((s, e) => s + e.cached, 0))
    expect(t.meanTokPerS).toBeCloseTo(done.reduce((s, e) => s + e.tokPerS, 0) / 52, 9)
    expect(t.acceptance).toBeCloseTo(done.reduce((s, e) => s + e.accepted.accepted, 0) / done.reduce((s, e) => s + e.accepted.proposed, 0), 9)
    const withPrefill = done.filter((e) => e.prefillS && e.prompt > e.cached)
    expect(t.prefillRate).toBeCloseTo(withPrefill.reduce((s, e) => s + e.prompt - e.cached, 0) / withPrefill.reduce((s, e) => s + (e.prefillS ?? 0), 0), 6)
    // the last done line's running totals, not a sum
    expect(t.cache).toEqual({ count: 0, gib: 0, hits: 22, misses: 31, evictions: 48 })
    expect(t.lastTokPerS).toBe(49.1)
  })

  it('is empty without requests', () => {
    expect(summarize([])).toMatchObject({ requests: 0, meanTokPerS: null, prefillRate: null, acceptance: null, cache: null })
  })

  it('feeds the sparkline with the last requests, oldest first', () => {
    const rows = rowsOf('k3-serve-2026-09-29.txt')
    expect(tokPerSSeries(rows, 3)).toEqual([58.5, 44.7, 49.1])
    expect(tokPerSSeries(rows)).toHaveLength(52)
  })
})
