import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LogEvent } from '@shared/events'
import { parseLine } from '../../src/main/LogParser'

function fixture(name: string): string[] {
  return readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8').split('\n').filter((l) => l !== '')
}

const APPENDIX_A = fixture('serve-log-2026-09-29.txt')
const DRAFTER = '/Users/peter/.cache/huggingface/hub/models--z-lab--Qwen3.8-27B-DFlash2/snapshots/50307d4c4cde6860d4eee73e2547cd786fe8e8a4'

describe('SPEC Appendix A, line by line', () => {
  it('has the fifteen lines of the appendix', () => {
    expect(APPENDIX_A).toHaveLength(15)
  })

  const refusalLine = APPENDIX_A[14] as string
  const refusalMessage = refusalLine.slice(refusalLine.indexOf('RequestError: ') + 'RequestError: '.length)

  const expected: LogEvent[] = [
    {
      kind: 'startup',
      what: 'memory-budget',
      budgetGib: 44.8,
      allowancePercent: null,
      mlxGib: 41.8,
      processGib: 3,
      ceilingGib: 51.8,
      sentence: "memory budget 44.8 GiB: MLX's buffers up to 41.8 GiB, 3 GiB for the rest of the process; TENSORFOLD_MEMORY_LIMIT_GB can raise it to 51.8"
    },
    { kind: 'startup', what: 'loading', model: 'Qwen3.8-27B-MLX-8bit', family: 'Qwen3.8 dense', modelType: 'qwen3_5', backend: 'mlx' },
    { kind: 'startup', what: 'lane-kernels', shapesWarmed: 9, fused: { zba: 48, kv: 16, gu: 64 } },
    { kind: 'startup', what: 'drafter', path: DRAFTER, repo: 'z-lab/Qwen3.8-27B-DFlash2', sha: '50307d4c4cde6860d4eee73e2547cd786fe8e8a4', block: 8, bits: 4 },
    { kind: 'startup', what: 'weights', residentGib: 31.1, fileBackedGib: null },
    { kind: 'startup', what: 'prompt-chunks', chunkTokens: 2048, replyGapTokens: 256 },
    {
      kind: 'startup',
      what: 'concurrency',
      lanes: 8,
      budgetGb: 36.2,
      mlxShareGb: 41.8,
      ramPercent: 70,
      ramGb: 64,
      elsewhereGb: 8.6,
      stream: { shortMb: 163, shortTokens: 64, longMb: 394, longTokens: 2112, perTokenKb: 114 },
      roundGb: null,
      fits: null
    },
    { kind: 'snapshot', action: 'loaded', scope: 'system-block', tokens: 640, ofTokens: null, gib: null, seconds: 0, fromDisk: true },
    {
      kind: 'serving',
      model: 'Qwen3.8-27B-MLX-8bit',
      url: 'http://127.0.0.1:8080/v1',
      host: '127.0.0.1',
      port: 8080,
      backend: 'mlx',
      sampling: { temperature: 1, top_k: 20, top_p: 0.95 },
      greedy: false,
      drafts: true,
      context: 89600,
      loadedInS: 31
    },
    { kind: 'access', client: '127.0.0.1', method: 'GET', path: '/v1/models', protocol: 'HTTP/1.1', status: 200, size: null },
    { kind: 'access', client: '127.0.0.1', method: 'POST', path: '/v1/chat/completions', protocol: 'HTTP/1.1', status: 200, size: null },
    { kind: 'snapshot', action: 'read', scope: 'conversation', tokens: 9370, ofTokens: null, gib: null, seconds: 0.06, fromDisk: true },
    {
      kind: 'done',
      reqId: 'req-a22838d887b0',
      prompt: 42,
      cached: 0,
      thinking: true,
      effort: 'low',
      tokens: 5,
      sha: '235a6b4690b8',
      finish: 'length',
      tokPerS: 59.1,
      ttftS: 0.72,
      prefillS: 0.72,
      background: false,
      preemptions: null,
      rounds: 1,
      accepted: { accepted: 4, proposed: 4 },
      msPerRound: 67.3,
      forwardMs: 67.3,
      draftMs: 0,
      postMs: 0,
      rows: 16.9,
      checkpoints: { count: 2, gib: 0.92, hits: 1, misses: 0, evictions: 0 },
      extra: {}
    },
    {
      kind: 'done',
      reqId: 'req-07bcd37c1ff7',
      prompt: 23124,
      cached: 0,
      thinking: true,
      effort: 'medium',
      tokens: 4598,
      sha: '5c969274b94d',
      finish: 'stop',
      tokPerS: 60.5,
      ttftS: 41.74,
      prefillS: 41.71,
      background: false,
      preemptions: null,
      rounds: 773,
      accepted: { accepted: 3824, proposed: 12792 },
      msPerRound: 98.2,
      forwardMs: 98.2,
      draftMs: 0,
      postMs: 0,
      rows: 17.5,
      checkpoints: { count: 0, gib: 0, hits: 13, misses: 17, evictions: 29 },
      extra: {}
    },
    {
      kind: 'refused',
      reqId: 'req-449c47a5f5a1',
      cached: 0,
      errorType: 'RequestError',
      message: refusalMessage,
      needGib: 41.8,
      ofGib: 41.8,
      promptFitTokens: 25225,
      replyTokens: 64000
    }
  ]

  APPENDIX_A.forEach((line, i) => {
    it(`line ${i + 1}: ${line.slice(13, 60)}…`, () => {
      expect(parseLine(line)).toEqual(expected[i])
    })
  })

  it('keeps the refusal message intact', () => {
    expect(refusalMessage.startsWith('This request needs about 41.8 GiB of the 41.8 GiB MLX may use')).toBe(true)
    expect(refusalMessage.endsWith('or a Mac with more RAM leave more room.')).toBe(true)
    expect(refusalMessage).toContain('(the reply is reserved in full)')
  })
})

describe('the K3 serve log of 2026-09-29 (145 real lines)', () => {
  const lines = fixture('k3-serve-2026-09-29.txt')
  const events = lines.map(parseLine)
  const count = (kind: string): number => events.filter((e) => e.kind === kind).length

  it('recognizes every line', () => {
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
  })

  it('finds the startup sequence, one serving line, the requests and the refusal', () => {
    expect(lines).toHaveLength(145)
    expect(count('startup')).toBe(8)
    expect(count('serving')).toBe(1)
    expect(count('done')).toBe(52)
    expect(count('refused')).toBe(1)
    expect(count('snapshot')).toBe(21)
    expect(count('access')).toBe(62)
  })

  it('reads the full concurrency line, which Appendix A cuts short', () => {
    const c = events.find((e) => e.kind === 'startup' && e.what === 'concurrency')
    expect(c).toMatchObject({ lanes: 8, budgetGb: 36.2, roundGb: 1.4, fits: { streams: 2, tokens: 8192 } })
  })

  it('reads the lane-kernel window timings', () => {
    const w = events.find((e) => e.kind === 'startup' && e.what === 'lane-windows')
    expect(w).toEqual({
      kind: 'startup',
      what: 'lane-windows',
      decoder: 'lane kernels',
      exactRows: 32,
      msByRows: { '1': 57.4, '2': 59.6, '4': 61.7, '8': 64.4, '16': 67.9, '17': 74.3, '32': 77.6, '64': 107, '128': 188.9 }
    })
  })

  it('reads the refusal, and the reply tokens the client asked for', () => {
    const r = events.find((e) => e.kind === 'refused')
    expect(r).toMatchObject({ reqId: 'req-ae4e28e6da3d', needGib: 41.8, ofGib: 41.8, promptFitTokens: 25632, replyTokens: 44000 })
  })

  it('reads a resumed conversation (26,204 of 26,209 prompt tokens cached)', () => {
    const d = events.find((e) => e.kind === 'done' && e.reqId === 'req-3c005e316298')
    expect(d).toMatchObject({ prompt: 26209, cached: 26204, ttftS: 0.24, prefillS: 0.18, tokens: 7908 })
  })

  it('reads 404 access lines', () => {
    const notFound = events.filter((e) => e.kind === 'access' && e.status === 404).map((e) => (e.kind === 'access' ? e.path : ''))
    expect(notFound).toEqual(['/metrics', '/slots', '/v1/stats', '/stats'])
  })
})

describe('lines the source can print that the samples do not show', () => {
  const T = (body: string): LogEvent => parseLine(`[tensorfold] ${body}`)

  it('done while other streams are active: no round profile', () => {
    const e = T('done req-1 prompt=10 cached=0 thinking=False effort=None tokens=3 sha=ab finish=stop tok/s=40.0 ttft=0.10s prefill=0.09s rounds=2 accepted=1/8 checkpoints=1 (0.10 GiB, hits=0 misses=1 evictions=0)')
    expect(e).toMatchObject({ kind: 'done', thinking: false, effort: null, msPerRound: null, forwardMs: null, draftMs: null, postMs: null, rows: null })
  })

  it('done with checkpoints=off, a background job and unmeasured timings', () => {
    const e = T('done warm-1a2b3c4d prompt=640 cached=0 thinking=True effort=medium tokens=1 sha=cd finish=length tok/s=0.0 ttft=-1.00s prefill=-1.00s background preemptions=2 rounds=0 accepted=0/0 checkpoints=off')
    expect(e).toMatchObject({ kind: 'done', reqId: 'warm-1a2b3c4d', background: true, preemptions: 2, ttftS: null, prefillS: null, checkpoints: null, rounds: 0 })
  })

  it('keeps fields a newer TensorFold adds', () => {
    const e = T('done req-2 prompt=1 cached=0 thinking=True effort=low tokens=1 sha=x finish=stop tok/s=1.0 ttft=0.01s prefill=0.01s rounds=1 accepted=0/0 streams=3 checkpoints=off')
    expect(e).toMatchObject({ kind: 'done', extra: { streams: '3' } })
  })

  it('falls back to unknown when a done line lacks what it needs', () => {
    expect(T('done req-3 prompt=abc').kind).toBe('unknown')
  })

  it('snapshots saved, warmed and spilled', () => {
    expect(T('saved system-block snapshot tokens=640 in 0.3s')).toEqual({ kind: 'snapshot', action: 'saved', scope: 'system-block', tokens: 640, ofTokens: null, gib: null, seconds: 0.3, fromDisk: false })
    expect(T('warmed system block tokens=512 of 640 in 1.2s')).toMatchObject({ action: 'warmed', tokens: 512, ofTokens: 640, seconds: 1.2 })
    expect(T('spilled conversation tokens=9370 (1.0 GiB) in 0.40s')).toMatchObject({ action: 'spilled', scope: 'conversation', gib: 1, seconds: 0.4 })
  })

  it('startup variants', () => {
    expect(T("memory budget 51.2 GiB (80% of RAM, this model's allowance): MLX's buffers up to 48.2 GiB, 3 GiB for the rest of the process")).toMatchObject({ what: 'memory-budget', budgetGib: 51.2, allowancePercent: 80, ceilingGib: null })
    expect(T('weights: 20.0 GiB resident, 9.8 GiB file-backed')).toEqual({ kind: 'startup', what: 'weights', residentGib: 20, fileBackedGib: 9.8 })
    expect(T('no draft model: `tensorfold pull z-lab/Qwen3.8-27B-DFlash2` once to draft with it')).toEqual({ kind: 'startup', what: 'no-drafter', repo: 'z-lab/Qwen3.8-27B-DFlash2' })
    expect(T("context window 65,536 tokens: the most one request can use in the 44.8 GiB memory budget (the model's window is 262,144); have clients compact before it")).toEqual({ kind: 'startup', what: 'context-window', tokens: 65536, budgetGib: 44.8, modelWindow: 262144 })
    expect(T('warming 2 saved system block(s) for these kernels in the background: until it ends, a request first waits for one prompt chunk (GET /health reports warming)')).toEqual({ kind: 'startup', what: 'warming', blocks: 2 })
    expect(T('note: foo/bar is not a checkpoint TensorFold is tested with (x). It runs when …')).toMatchObject({ kind: 'startup', what: 'note' })
    expect(T('loading Flash: Qwen3.8 Flash Next (qwen4_exp) on CUDA rank 0')).toMatchObject({ what: 'loading', backend: 'cuda', modelType: 'qwen4_exp' })
  })

  it('serving variants: greedy, unlimited context, drafts off', () => {
    expect(T('serving m at http://0.0.0.0:9000/v1 (sampling: greedy; drafts: off; context: unlimited; loaded in 2.5s)')).toEqual({
      kind: 'serving', model: 'm', url: 'http://0.0.0.0:9000/v1', host: '0.0.0.0', port: 9000, backend: 'mlx',
      sampling: {}, greedy: true, drafts: false, context: null, loadedInS: 2.5
    })
  })

  it('failures', () => {
    expect(T('request error: RuntimeError: boom: again')).toEqual({ kind: 'error', what: 'request', errorType: 'RuntimeError', message: 'boom: again' })
    expect(T('stream error: ValueError: bad')).toMatchObject({ what: 'stream', errorType: 'ValueError' })
    expect(T('snapshot save failed: OSError: [Errno 28] No space left on device')).toMatchObject({ what: 'snapshot-save', errorType: 'OSError' })
    expect(T('Qwen3.8 dense cannot run this checkpoint: the tied embedding head is not supported. Use Vontra/Qwen3.8-27B-MLX-4bit')).toMatchObject({ kind: 'error', what: 'fatal' })
    expect(parseLine("tensorfold: [Errno 2] No such file or directory: '/x/config.json'")).toEqual({
      kind: 'error', what: 'fatal', errorType: null, message: "[Errno 2] No such file or directory: '/x/config.json'"
    })
  })

  it('notices', () => {
    expect(T('slow round 812 ms streams=3 width=24 rows=48 forward=790')).toMatchObject({ what: 'slow-round', fields: { ms: 812, streams: 3, width: 24, rows: 48, forward: 790 } })
    expect(T("stalled 125s: queued=2 held=False jobs=3 active=1 starting=True; every thread's stack follows")).toMatchObject({
      what: 'stalled', fields: { seconds: 125, queued: 2, held: false, jobs: 3, active: 1, starting: true }
    })
    expect(T('TensorFold 0.4.0 is available (this is 0.3.6.2): run `tensorfold update`, then restart the server')).toMatchObject({ what: 'update-available', fields: { latest: '0.4.0', current: '0.3.6.2' } })
    expect(T('downloading z-lab/Qwen3.8-27B-DFlash2 from Hugging Face')).toMatchObject({ what: 'downloading', fields: { repo: 'z-lab/Qwen3.8-27B-DFlash2' } })
  })

  it('unknown lines, never a throw', () => {
    for (const line of ['', 'Traceback (most recent call last):', '  File "x.py", line 1', 'Fetching 4 files:  25%|██▌       | 1/4', '[tensorfold] something new', '[tensorfold] done']) {
      expect(parseLine(line)).toEqual({ kind: 'unknown', line })
    }
  })

  it('ignores a trailing carriage return', () => {
    expect(parseLine('[tensorfold] 127.0.0.1 "GET /health HTTP/1.1" 200 -\r')).toMatchObject({ kind: 'access', path: '/health' })
  })
})
