/**
 * One line of `tensorfold serve` output in, one event out (SPEC §4). Pure: no state, no I/O, never throws.
 * Anything it does not recognize is `{ kind: 'unknown' }`, so a newer TensorFold degrades to raw lines.
 * Most lines start `[tensorfold] `; the lane engine and some families print under their own tag (`[lanes] `,
 * `[glm5] `, `[gemma4] `, `[nemotron] `, `[deepseek_v4] `).
 */
import type {
  ConcurrencyStartup,
  DoneEvent,
  ErrorEvent,
  LogEvent,
  NoticeEvent,
  RefusedEvent,
  ServingEvent,
  SnapshotEvent
} from '@shared/events'

const PREFIX = '[tensorfold] '

/** "2,048" → 2048; "41.74s" → 41.74. NaN when it is not a number. */
function num(text: string | undefined): number {
  if (text === undefined) return NaN
  return Number(text.replace(/,/g, '').replace(/s$/, ''))
}

function numOrNull(text: string | undefined): number | null {
  const value = num(text)
  return Number.isFinite(value) ? value : null
}

function unknown(line: string): LogEvent {
  return { kind: 'unknown', line }
}

export function parseLine(raw: string): LogEvent {
  const line = raw.replace(/[\r\n]+$/, '')
  if (line.startsWith(PREFIX)) {
    try {
      return parseBody(line.slice(PREFIX.length)) ?? unknown(line)
    } catch {
      return unknown(line)
    }
  }
  const fatal = /^tensorfold: (.*)$/.exec(line)
  if (fatal) return { kind: 'error', what: 'fatal', errorType: null, message: fatal[1] as string }
  const tagged = /^\[([a-z][a-z0-9_]*)\] (.*)$/s.exec(line)
  if (tagged) {
    try {
      return parseTagged(tagged[1] as string, tagged[2] as string) ?? unknown(line)
    } catch {
      return unknown(line)
    }
  }
  return unknown(line)
}

/** Startup lines a family prints under its own tag, once (both versions' source). */
const TAGGED_NOTES = [
  /^forward costs timed up to \d+ rows of a shared round's \d+/,
  /windows of up to \d+ rows reproduce one-(row|token) steps/,
  /^row-exact kernels: /,
  /^no verify window reproduces one-token steps/,
  /^routed experts stream from SSD into /,
  /does not reproduce (each stream's own call|serial steps)/,
  /^exact window \d+ rows, forward ms by width /
]

/** A line under an engine's or a family's tag: `[lanes] saved conversation checkpoint …`, `[glm5] exact window …`. */
function parseTagged(tag: string, body: string): LogEvent | null {
  let m = /^saved conversation checkpoint tokens=(\d+) \(([\d.]+) GiB\) in ([\d.]+)s$/.exec(body)
  if (m) return { kind: 'snapshot', action: 'saved', scope: 'conversation', tokens: num(m[1]), ofTokens: null, gib: num(m[2]), seconds: num(m[3]), fromDisk: false }
  m = /^conversation save failed: (?:([A-Za-z_]\w*): )?(.*)$/s.exec(body)
  if (m) return { kind: 'error', what: 'snapshot-save', errorType: m[1] ?? null, message: m[2] as string }
  if (/^(drafter build ms\/round|family rounds: |shared rounds: )|capture (write )?failed: /.test(body)) {
    return { kind: 'notice', what: 'diagnostic', text: `${tag}: ${body}`, fields: { tag } }
  }
  if (TAGGED_NOTES.some((p) => p.test(body))) return { kind: 'startup', what: 'note', text: `${tag}: ${body}` }
  return null
}

type Matcher = (body: string) => LogEvent | null

const MATCHERS: Matcher[] = [
  done,
  refused,
  access,
  snapshot,
  serving,
  memoryBudget,
  loading,
  laneKernels,
  laneWindows,
  drafter,
  noDrafter,
  weights,
  promptChunks,
  concurrency,
  contextWindow,
  resumable,
  warming,
  failure,
  notice,
  note
]

function parseBody(body: string): LogEvent | null {
  for (const match of MATCHERS) {
    const event = match(body)
    if (event) return event
  }
  return null
}

// ---------------------------------------------------------------- per request

const DONE_KEYS = new Set([
  'prompt', 'cached', 'thinking', 'effort', 'tokens', 'sha', 'finish', 'tok/s', 'ttft', 'prefill', 'preemptions',
  'rounds', 'accepted', 'ms/round', 'forward', 'draft', 'post', 'rows'
])

function pyBool(text: string | undefined): boolean | null {
  if (text === 'True') return true
  if (text === 'False') return false
  return null
}

/** Seconds, with TensorFold's -1.00s meaning "not measured". */
function seconds(text: string | undefined): number | null {
  const value = numOrNull(text)
  return value === null || value < 0 ? null : value
}

function done(body: string): DoneEvent | null {
  const head = /^done (\S+) /.exec(body)
  if (!head) return null
  let rest = body.slice(head[0].length)

  let checkpoints: DoneEvent['checkpoints'] = null
  const tally = /\s*checkpoints=(\d+) \(([\d.]+) GiB, hits=(\d+) misses=(\d+) evictions=(\d+)\)\s*$/.exec(rest)
  if (tally) {
    checkpoints = { count: num(tally[1]), gib: num(tally[2]), hits: num(tally[3]), misses: num(tally[4]), evictions: num(tally[5]) }
    rest = rest.slice(0, tally.index)
  } else {
    const off = /\s*checkpoints=off\s*$/.exec(rest)
    if (off) rest = rest.slice(0, off.index)
  }

  const fields: Record<string, string> = {}
  const extra: Record<string, string> = {}
  let background = false
  for (const word of rest.trim().split(/\s+/)) {
    if (word === '') continue
    const eq = word.indexOf('=')
    if (eq < 0) {
      if (word === 'background') background = true
      else extra[word] = ''
      continue
    }
    const key = word.slice(0, eq)
    const value = word.slice(eq + 1)
    if (DONE_KEYS.has(key)) fields[key] = value
    else extra[key] = value
  }

  const accepted = /^(\d+)\/(\d+)$/.exec(fields['accepted'] ?? '')
  const required = [fields['prompt'], fields['cached'], fields['tokens'], fields['tok/s'], fields['rounds']].map(num)
  if (!accepted || required.some((v) => !Number.isFinite(v))) return null
  const [prompt, cached, tokens, tokPerS, rounds] = required as [number, number, number, number, number]

  return {
    kind: 'done',
    reqId: head[1] as string,
    prompt,
    cached,
    thinking: pyBool(fields['thinking']),
    effort: fields['effort'] === undefined || fields['effort'] === 'None' ? null : fields['effort'],
    tokens,
    sha: fields['sha'] ?? '',
    finish: fields['finish'] ?? '',
    tokPerS,
    ttftS: seconds(fields['ttft']),
    prefillS: seconds(fields['prefill']),
    background,
    preemptions: numOrNull(fields['preemptions']),
    rounds,
    accepted: { accepted: num(accepted[1]), proposed: num(accepted[2]) },
    msPerRound: numOrNull(fields['ms/round']),
    forwardMs: numOrNull(fields['forward']),
    draftMs: numOrNull(fields['draft']),
    postMs: numOrNull(fields['post']),
    rows: numOrNull(fields['rows']),
    checkpoints,
    extra
  }
}

function refused(body: string): RefusedEvent | null {
  const m = /^start failed (\S+)(?: cached=(\d+))?: (?:([A-Za-z_]\w*): )?(.*)$/s.exec(body)
  if (!m) return null
  const message = m[4] as string
  const need = /needs about ([\d.]+) GiB of the ([\d.]+) GiB/.exec(message)
  const fit = /fits up to ([\d,]+) tokens in the prompt with ([\d,]+) reply tokens/.exec(message)
  const asks = fit ? null : /requests ([\d,]+) reply tokens/.exec(message)
  return {
    kind: 'refused',
    reqId: m[1] as string,
    cached: m[2] === undefined ? 0 : num(m[2]),
    errorType: m[3] ?? '',
    message,
    needGib: need ? num(need[1]) : null,
    ofGib: need ? num(need[2]) : null,
    promptFitTokens: fit ? num(fit[1]) : null,
    replyTokens: fit ? num(fit[2]) : asks ? num(asks[1]) : null
  }
}

function access(body: string): LogEvent | null {
  const m = /^(\S+) "([A-Z]+) (\S+) (HTTP\/[\d.]+)" (\d{3}) (\S+)$/.exec(body)
  if (!m) return null
  return {
    kind: 'access',
    client: m[1] as string,
    method: m[2] as string,
    path: m[3] as string,
    protocol: m[4] as string,
    status: num(m[5]),
    size: m[6] === '-' ? null : numOrNull(m[6])
  }
}

function snapshot(body: string): SnapshotEvent | null {
  let m = /^(loaded|saved) (system-block|conversation) snapshot tokens=(\d+) in ([\d.]+)s$/.exec(body)
  if (m) {
    return {
      kind: 'snapshot',
      action: m[1] as 'loaded' | 'saved',
      scope: m[2] as SnapshotEvent['scope'],
      tokens: num(m[3]),
      ofTokens: null,
      gib: null,
      seconds: num(m[4]),
      fromDisk: m[1] === 'loaded'
    }
  }
  m = /^read (system-block|conversation) snapshot tokens=(\d+) from disk in ([\d.]+)s$/.exec(body)
  if (m) {
    return {
      kind: 'snapshot',
      action: 'read',
      scope: m[1] as SnapshotEvent['scope'],
      tokens: num(m[2]),
      ofTokens: null,
      gib: null,
      seconds: num(m[3]),
      fromDisk: true
    }
  }
  m = /^warmed system block tokens=(\d+) of (\d+) in ([\d.]+)s$/.exec(body)
  if (m) {
    return { kind: 'snapshot', action: 'warmed', scope: 'system-block', tokens: num(m[1]), ofTokens: num(m[2]), gib: null, seconds: num(m[3]), fromDisk: false }
  }
  m = /^spilled conversation tokens=(\d+) \(([\d.]+) GiB\) in ([\d.]+)s$/.exec(body)
  if (m) {
    return { kind: 'snapshot', action: 'spilled', scope: 'conversation', tokens: num(m[1]), ofTokens: null, gib: num(m[2]), seconds: num(m[3]), fromDisk: false }
  }
  return null
}

// ---------------------------------------------------------------- startup and serving

function serving(body: string): ServingEvent | null {
  const m = /^serving (.+?) at (https?):\/\/(\S+):(\d+)\/v1( on CUDA[^(]*)? \((.*)\)$/.exec(body)
  if (!m) return null
  const parts = new Map<string, string>()
  for (const part of (m[6] as string).split('; ')) {
    const colon = part.indexOf(': ')
    if (colon > 0) parts.set(part.slice(0, colon), part.slice(colon + 2))
  }
  const shown = parts.get('sampling') ?? ''
  const greedy = shown === 'greedy'
  const sampling: Record<string, number> = {}
  if (!greedy) {
    for (const pair of shown.split(', ')) {
      const [key, value] = pair.split(' ')
      if (key && value !== undefined && Number.isFinite(num(value))) sampling[key] = num(value)
    }
  }
  const context = parts.get('context')
  const loaded = /(?:^|; )loaded in ([\d.]+)s$/.exec(m[6] as string)
  const host = m[3] as string
  const port = num(m[4])
  return {
    kind: 'serving',
    model: m[1] as string,
    url: `${m[2]}://${host}:${port}/v1`,
    host,
    port,
    backend: m[5] ? 'cuda' : 'mlx',
    sampling,
    greedy,
    drafts: parts.get('drafts') !== 'off',
    context: context === undefined || context === 'unlimited' ? null : num(context),
    loadedInS: loaded ? num(loaded[1]) : NaN
  }
}

function memoryBudget(body: string): LogEvent | null {
  const m =
    /^memory budget ([\d.]+) GiB(?: \((\d+)% of RAM, this model's allowance\))?: MLX's buffers up to ([\d.]+) GiB, ([\d.]+) GiB for the rest of the process(?:; TENSORFOLD_MEMORY_LIMIT_GB can raise it to ([\d.]+))?$/.exec(
      body
    )
  if (!m) return null
  return {
    kind: 'startup',
    what: 'memory-budget',
    budgetGib: num(m[1]),
    allowancePercent: numOrNull(m[2]),
    mlxGib: num(m[3]),
    processGib: num(m[4]),
    ceilingGib: numOrNull(m[5]),
    sentence: body
  }
}

function loading(body: string): LogEvent | null {
  const m = /^loading (.+?): (.+) \(([^()\s]+)\)( on CUDA.*)?$/.exec(body)
  if (!m) return null
  return { kind: 'startup', what: 'loading', model: m[1] as string, family: m[2] as string, modelType: m[3] as string, backend: m[4] ? 'cuda' : 'mlx' }
}

/** Python's repr of a str→int dict, e.g. {'zba': 48, 'kv': 16}. */
function pyDict(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(/'([^']*)':\s*(-?[\d.]+)/g)) out[m[1] as string] = num(m[2])
  return out
}

function laneKernels(body: string): LogEvent | null {
  const m = /^lane kernels on: (\d+) matmul shapes warmed, fused projections (\{.*\})$/.exec(body)
  if (!m) return null
  return { kind: 'startup', what: 'lane-kernels', shapesWarmed: num(m[1]), fused: pyDict(m[2] as string) }
}

function laneWindows(body: string): LogEvent | null {
  const m = /^(lane kernels|lane decoder without tensor units): windows of up to (\d+) rows reproduce one-row steps here \(ms by rows (.*)\)$/.exec(body)
  if (!m) return null
  const msByRows: Record<string, number> = {}
  for (const pair of (m[3] as string).split(', ')) {
    const [rows, ms] = pair.split(': ')
    if (rows !== undefined && ms !== undefined) msByRows[rows] = num(ms)
  }
  return { kind: 'startup', what: 'lane-windows', decoder: m[1] as string, exactRows: num(m[2]), msByRows }
}

function hubRepo(path: string): { repo: string | null; sha: string | null } {
  const m = /models--([^/]+?)--([^/]+)\/snapshots\/([0-9a-f]+)/.exec(path)
  return m ? { repo: `${m[1]}/${m[2]}`, sha: m[3] as string } : { repo: null, sha: null }
}

function drafter(body: string): LogEvent | null {
  const m = /^drafter (.+) block=(\d+) bits=(\d+)$/.exec(body)
  if (!m) return null
  const path = m[1] as string
  return { kind: 'startup', what: 'drafter', path, ...hubRepo(path), block: num(m[2]), bits: num(m[3]) }
}

function noDrafter(body: string): LogEvent | null {
  const m = /^no draft model: `tensorfold pull (\S+)` once to draft with it$/.exec(body)
  return m ? { kind: 'startup', what: 'no-drafter', repo: m[1] as string } : null
}

function weights(body: string): LogEvent | null {
  let m = /^([\d.]+) GiB of weights kept resident$/.exec(body)
  if (m) return { kind: 'startup', what: 'weights', residentGib: num(m[1]), fileBackedGib: null }
  m = /^weights: ([\d.]+) GiB resident, ([\d.]+) GiB file-backed$/.exec(body)
  if (m) return { kind: 'startup', what: 'weights', residentGib: num(m[1]), fileBackedGib: num(m[2]) }
  return null
}

function promptChunks(body: string): LogEvent | null {
  const m = /^prompt chunks of up to ([\d,]+) tokens, cut at replies ([\d,]+)\+ tokens apart$/.exec(body)
  return m ? { kind: 'startup', what: 'prompt-chunks', chunkTokens: num(m[1]), replyGapTokens: num(m[2]) } : null
}

function concurrency(body: string): ConcurrencyStartup | null {
  const m = new RegExp(
    [
      /^concurrency: up to (\d+) requests? share each round; /.source,
      /memory budget ([\d.]+) GB \(MLX's share ([\d.]+) GB, or (\d+)% of ([\d.]+) GB less ([\d.]+) GB in use elsewhere\); /.source,
      /a stream ([\d.]+) MB at ([\d,]+) tokens, ([\d.]+) MB at ([\d,]+), then ([\d.]+) KB a token/.source,
      /(?:; a shared round up to ([\d.]+) GB(?: at (\d+) streams?)?)?/.source,
      /(?:; ([\d,]+) streams? of ([\d,]+) tokens fit now \(more wait their turn\))?$/.source
    ].join('')
  ).exec(body)
  if (!m) return null
  return {
    kind: 'startup',
    what: 'concurrency',
    lanes: num(m[1]),
    budgetGb: num(m[2]),
    mlxShareGb: num(m[3]),
    ramPercent: num(m[4]),
    ramGb: num(m[5]),
    elsewhereGb: num(m[6]),
    stream: { shortMb: num(m[7]), shortTokens: num(m[8]), longMb: num(m[9]), longTokens: num(m[10]), perTokenKb: num(m[11]) },
    roundGb: numOrNull(m[12]),
    roundStreams: numOrNull(m[13]),
    fits: m[14] === undefined ? null : { streams: num(m[14]), tokens: num(m[15]) }
  }
}

function contextWindow(body: string): LogEvent | null {
  const m =
    /^context window ([\d,]+) tokens: the most one request can use in the ([\d.]+) GiB memory budget( and still keep its prompt for the next turn)? \(the model's window is ([\d,]+)\); have clients compact before it$/.exec(
      body
    )
  return m ? { kind: 'startup', what: 'context-window', tokens: num(m[1]), budgetGib: num(m[2]), modelWindow: num(m[4]), keepsPrompt: m[3] !== undefined } : null
}

function resumable(body: string): LogEvent | null {
  const m = /^requests up to ([\d,]+) tokens keep their prompt for the next turn in the ([\d.]+) GiB memory budget; a longer one is served, and its next turn prefills again$/.exec(body)
  return m ? { kind: 'startup', what: 'resumable', tokens: num(m[1]), budgetGib: num(m[2]) } : null
}

function warming(body: string): LogEvent | null {
  const m = /^warming (\d+) saved system block\(s\) for these kernels in the background/.exec(body)
  return m ? { kind: 'startup', what: 'warming', blocks: num(m[1]) } : null
}

// ---------------------------------------------------------------- failures, notices, notes

const FAILURES: Array<[RegExp, ErrorEvent['what']]> = [
  [/^request error: /, 'request'],
  [/^stream error: /, 'stream'],
  [/^snapshot read failed: /, 'snapshot-read'],
  [/^snapshot save failed: /, 'snapshot-save'],
  [/^conversation spill failed: /, 'spill'],
  [/^eviction hook failed: /, 'eviction-hook'],
  [/^shutdown hook failed: /, 'shutdown-hook']
]

/** A family refusing a checkpoint at startup (raised as SystemExit with the prefix). */
const FATAL = /cannot run this checkpoint|do not take this checkpoint|do not read this checkpoint|needs Metal 4 tensor units|does not take these weights|threads a threadgroup/

function failure(body: string): ErrorEvent | null {
  for (const [pattern, what] of FAILURES) {
    const m = pattern.exec(body)
    if (!m) continue
    const rest = body.slice(m[0].length)
    const typed = /^([A-Za-z_]\w*): (.*)$/s.exec(rest)
    return { kind: 'error', what, errorType: typed ? (typed[1] as string) : null, message: typed ? (typed[2] as string) : rest }
  }
  if (FATAL.test(body)) return { kind: 'error', what: 'fatal', errorType: null, message: body }
  return null
}

function keyValues(text: string): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {}
  for (const m of text.matchAll(/(\w+)=(\S+)/g)) {
    const raw = (m[2] as string).replace(/[;,]$/, '')
    const value = num(raw)
    out[m[1] as string] = raw === 'True' ? true : raw === 'False' ? false : Number.isFinite(value) ? value : raw
  }
  return out
}

function notice(body: string): NoticeEvent | null {
  let m = /^slow round (\d+) ms streams=(\d+) width=(\d+) rows=(\d+) forward=(\d+)$/.exec(body)
  if (m) {
    return {
      kind: 'notice',
      what: 'slow-round',
      text: body,
      fields: { ms: num(m[1]), streams: num(m[2]), width: num(m[3]), rows: num(m[4]), forward: num(m[5]) }
    }
  }
  m = /^stalled (\d+)s: (.*); every thread's stack follows$/.exec(body)
  if (m) return { kind: 'notice', what: 'stalled', text: body, fields: { seconds: num(m[1]), ...keyValues(m[2] as string) } }
  if (body.startsWith('rerun of a preempted request diverged')) return { kind: 'notice', what: 'diverged', text: body, fields: {} }
  m = /^TensorFold (\S+) is available \(this is (\S+)\)/.exec(body)
  if (m) return { kind: 'notice', what: 'update-available', text: body, fields: { latest: m[1] as string, current: m[2] as string } }
  m = /^this is TensorFold (\S+); what's new: (\S+)$/.exec(body)
  if (m) return { kind: 'notice', what: 'whats-new', text: body, fields: { version: m[1] as string, url: m[2] as string } }
  m = /^downloading (\S+) from Hugging Face$/.exec(body)
  if (m) return { kind: 'notice', what: 'downloading', text: body, fields: { repo: m[1] as string } }
  if (/^prefill matmul kernels (unavailable|differ)/.test(body)) return { kind: 'notice', what: 'kernels-fallback', text: body, fields: {} }
  m = /^memory: (\d+) of (\d+) streams? wait for room \(newest first\)$/.exec(body)
  if (m) return { kind: 'notice', what: 'memory-wait', text: body, fields: { waiting: num(m[1]), streams: num(m[2]) } }
  m = /^memory: ended (\S+), the newest of (\d+) streams?$/.exec(body)
  if (m) return { kind: 'notice', what: 'memory-ended', text: body, fields: { reqId: m[1] as string, streams: num(m[2]) } }
  m = /^WARNING: (.*)$/s.exec(body)
  if (m) return { kind: 'notice', what: 'warning', text: body, fields: { message: m[1] as string } }
  if (/^={20,}$/.test(body)) return { kind: 'notice', what: 'warning', text: body, fields: { rule: true } }
  return null
}

const NOTES = [
  /^note: /,
  /^EXL3 (support is|packs are) experimental/,
  /^this (\S+ )?checkpoint has no MTP (head|layer)/,
  /^\d+ tensors are not 4-bit/,
  /^GLM-5\.3-Flash runs on two NVIDIA GPUs/,
  /^Nemotron MTP head: /,
  /^rank 1 ready in /,
  /^required model files ready: /,
  /^image encoder: [\d.]+ GiB workspace measured/,
  /^config\.json lists a layer type for each MTP layer too/,
  /: the codes widened to 4 bits would leave too little of this Mac's memory budget/,
  /: \d+ of \d+ layers widened for speed/
]

function note(body: string): LogEvent | null {
  return NOTES.some((p) => p.test(body)) ? { kind: 'startup', what: 'note', text: body } : null
}
