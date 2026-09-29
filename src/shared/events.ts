/**
 * What `tensorfold serve` prints, parsed: src/main/LogParser.ts turns one line into one event.
 * Formats are the installed 0.3.6.2's (SPEC §2.3 and Appendix A, the K3 serve log of 2026-09-29, and
 * the release's source). Numbers are numbers, durations are seconds, sizes keep the unit the line
 * states (GiB, GB, MB, KB are TensorFold's own, and it is not always consistent about GiB vs GB).
 */

export type LogEvent =
  | StartupEvent
  | ServingEvent
  | DoneEvent
  | RefusedEvent
  | AccessEvent
  | SnapshotEvent
  | ErrorEvent
  | NoticeEvent
  | UnknownEvent

export type LogEventKind = LogEvent['kind']

// ---------------------------------------------------------------- startup (printed before "serving")

export type StartupEvent =
  | MemoryBudgetStartup
  | LoadingStartup
  | LaneKernelsStartup
  | LaneWindowsStartup
  | DrafterStartup
  | NoDrafterStartup
  | WeightsStartup
  | PromptChunksStartup
  | ConcurrencyStartup
  | ContextWindowStartup
  | WarmingStartup
  | NoteStartup

/** `memory budget 44.8 GiB: MLX's buffers up to 41.8 GiB, 3 GiB for the rest of the process; TENSORFOLD_MEMORY_LIMIT_GB can raise it to 51.8` */
export interface MemoryBudgetStartup {
  kind: 'startup'
  what: 'memory-budget'
  budgetGib: number
  /** "(N% of RAM, this model's allowance)", when the family raises the usual 70% */
  allowancePercent: number | null
  mlxGib: number
  processGib: number
  /** The ceiling TENSORFOLD_MEMORY_LIMIT_GB can raise the budget to; absent when there is no headroom. */
  ceilingGib: number | null
  /** The line without its prefix, quoted once under the memory gauge. */
  sentence: string
}

/** `loading Qwen3.8-27B-MLX-8bit: Qwen3.8 dense (qwen3_5)` */
export interface LoadingStartup {
  kind: 'startup'
  what: 'loading'
  model: string
  family: string
  modelType: string
  backend: 'mlx' | 'cuda'
}

/** `lane kernels on: 9 matmul shapes warmed, fused projections {'zba': 48, 'kv': 16, 'gu': 64}` */
export interface LaneKernelsStartup {
  kind: 'startup'
  what: 'lane-kernels'
  shapesWarmed: number
  fused: Record<string, number>
}

/** `lane kernels: windows of up to 32 rows reproduce one-row steps here (ms by rows 1: 57.4, 2: 59.6, …)` */
export interface LaneWindowsStartup {
  kind: 'startup'
  what: 'lane-windows'
  decoder: string
  exactRows: number
  /** Row count (as text) to milliseconds. */
  msByRows: Record<string, number>
}

/** `drafter /…/models--z-lab--Qwen3.8-27B-DFlash2/snapshots/50307d4c… block=8 bits=4` */
export interface DrafterStartup {
  kind: 'startup'
  what: 'drafter'
  path: string
  /** From a Hugging Face cache path: `z-lab/Qwen3.8-27B-DFlash2`. */
  repo: string | null
  /** The snapshot's commit sha, from a Hugging Face cache path. */
  sha: string | null
  block: number
  bits: number
}

/** ``no draft model: `tensorfold pull z-lab/Qwen3.8-27B-DFlash2` once to draft with it`` */
export interface NoDrafterStartup {
  kind: 'startup'
  what: 'no-drafter'
  repo: string
}

/** `31.1 GiB of weights kept resident`, or `weights: 20.0 GiB resident, 9.8 GiB file-backed` */
export interface WeightsStartup {
  kind: 'startup'
  what: 'weights'
  residentGib: number
  fileBackedGib: number | null
}

/** `prompt chunks of up to 2,048 tokens, cut at replies 256+ tokens apart` */
export interface PromptChunksStartup {
  kind: 'startup'
  what: 'prompt-chunks'
  chunkTokens: number
  replyGapTokens: number
}

/**
 * `concurrency: up to 8 requests share each round; memory budget 36.2 GB (MLX's share 41.8 GB, or 70% of
 * 64 GB less 8.6 GB in use elsewhere); a stream 163 MB at 64 tokens, 394 MB at 2,112, then 114.0 KB a token;
 * a shared round up to 1.40 GB; 2 streams of 8,192 tokens fit now (more wait their turn)`
 * (SPEC Appendix A's copy stops after "a token"; the last two clauses are then null.)
 */
export interface ConcurrencyStartup {
  kind: 'startup'
  what: 'concurrency'
  lanes: number
  budgetGb: number
  mlxShareGb: number
  ramPercent: number
  ramGb: number
  elsewhereGb: number
  stream: { shortMb: number; shortTokens: number; longMb: number; longTokens: number; perTokenKb: number }
  roundGb: number | null
  fits: { streams: number; tokens: number } | null
}

/** `context window 65,536 tokens: the most one request can use in the 44.8 GiB memory budget (the model's window is 262,144); have clients compact before it` */
export interface ContextWindowStartup {
  kind: 'startup'
  what: 'context-window'
  tokens: number
  budgetGib: number
  modelWindow: number
}

/** `warming 2 saved system block(s) for these kernels in the background: …` */
export interface WarmingStartup {
  kind: 'startup'
  what: 'warming'
  blocks: number
}

/** Informational startup lines: an untested checkpoint, EXL3 packs, a missing MTP head, and the like. */
export interface NoteStartup {
  kind: 'startup'
  what: 'note'
  text: string
}

// ---------------------------------------------------------------- serving

/** `serving Qwen3.8-27B-MLX-8bit at http://127.0.0.1:8080/v1 (sampling: temperature 1.0, top_k 20, top_p 0.95; drafts: on; context: 89600; loaded in 31.0s)` */
export interface ServingEvent {
  kind: 'serving'
  model: string
  /** The OpenAI base URL, ending in /v1. */
  url: string
  host: string
  port: number
  backend: 'mlx' | 'cuda'
  sampling: Record<string, number>
  drafts: boolean
  /** null: "unlimited". */
  context: number | null
  loadedInS: number
}

// ---------------------------------------------------------------- per request

/** `done req-… prompt=… cached=… thinking=True effort=medium tokens=… sha=… finish=stop tok/s=60.5 ttft=41.74s prefill=41.71s rounds=773 accepted=3824/12792 ms/round=98.2 forward=98.2 draft=0.0 post=0.0 rows=17.5 checkpoints=0 (0.00 GiB, hits=13 misses=17 evictions=29)` */
export interface DoneEvent {
  kind: 'done'
  reqId: string
  prompt: number
  cached: number
  /** Python's True/False; null for None. */
  thinking: boolean | null
  effort: string | null
  tokens: number
  sha: string
  finish: string
  tokPerS: number
  /** Seconds; null where the log says -1.00s (not measured). */
  ttftS: number | null
  prefillS: number | null
  /** `background preemptions=N`: a background (warming) job. */
  background: boolean
  preemptions: number | null
  rounds: number
  accepted: { accepted: number; proposed: number }
  /** The round profile is omitted while other streams are active, so these are null then. */
  msPerRound: number | null
  forwardMs: number | null
  draftMs: number | null
  postMs: number | null
  rows: number | null
  /**
   * The prefix-cache tally: `count` and `gib` are the store now; `hits`, `misses`, `evictions` are the
   * server's running totals (not this request's). null for `checkpoints=off`.
   */
  checkpoints: { count: number; gib: number; hits: number; misses: number; evictions: number } | null
  /** key=value fields this parser does not know (a newer TensorFold). */
  extra: Record<string, string>
}

/**
 * `start failed req-… cached=0: RequestError: This request needs about 41.8 GiB of the 41.8 GiB MLX may use (…);
 * it fits up to 25,225 tokens in the prompt with 64,000 reply tokens. …`
 * Admission refused the request before prefill. A refusal, not an error of the app.
 */
export interface RefusedEvent {
  kind: 'refused'
  reqId: string
  cached: number
  errorType: string
  /** Everything after the error type, intact. */
  message: string
  needGib: number | null
  ofGib: number | null
  promptFitTokens: number | null
  /** The reply tokens the client asked for (its max_tokens), when the message states them. */
  replyTokens: number | null
}

/** `127.0.0.1 "POST /v1/chat/completions HTTP/1.1" 200 -`: written when the headers go out, so a refused stream still logs 200. */
export interface AccessEvent {
  kind: 'access'
  client: string
  method: string
  path: string
  protocol: string
  status: number
  /** null for "-". */
  size: number | null
}

/**
 * `loaded system-block snapshot tokens=640 in 0.0s`, `read conversation snapshot tokens=9370 from disk in 0.06s`,
 * `saved system-block snapshot tokens=… in …s`, `warmed system block tokens=… of … in …s`,
 * `spilled conversation tokens=… (… GiB) in …s`
 */
export interface SnapshotEvent {
  kind: 'snapshot'
  action: 'loaded' | 'read' | 'saved' | 'warmed' | 'spilled'
  scope: 'system-block' | 'conversation'
  tokens: number
  /** warmed N of M */
  ofTokens: number | null
  /** spilled (X GiB) */
  gib: number | null
  seconds: number
  fromDisk: boolean
}

// ---------------------------------------------------------------- failures and notices

/**
 * `request error: T: …` (HTTP 500), `stream error: T: …`, `snapshot read failed: T: …`, `snapshot save failed: …`,
 * `conversation spill failed: …`, `eviction hook failed: …`, `shutdown hook failed: …`, and fatal startup errors
 * (`tensorfold: …` on stderr, or a family's "cannot run this checkpoint").
 */
export interface ErrorEvent {
  kind: 'error'
  what: 'request' | 'stream' | 'snapshot-read' | 'snapshot-save' | 'spill' | 'eviction-hook' | 'shutdown-hook' | 'fatal'
  errorType: string | null
  message: string
}

/**
 * `slow round 812 ms streams=3 width=24 rows=48 forward=790`, `stalled 125s: queued=… ; every thread's stack follows`,
 * `rerun of a preempted request diverged: …`, update notices, `downloading <repo> from Hugging Face`,
 * `prefill matmul kernels unavailable (…)`.
 */
export interface NoticeEvent {
  kind: 'notice'
  what: 'slow-round' | 'stalled' | 'diverged' | 'update-available' | 'whats-new' | 'downloading' | 'kernels-fallback'
  text: string
  fields: Record<string, number | string | boolean>
}

/** Anything else: tracebacks, progress bars, lines of a newer TensorFold. Never a crash. */
export interface UnknownEvent {
  kind: 'unknown'
  line: string
}

// ---------------------------------------------------------------- lines as the app keeps them

/** stdout and stderr of the child; 'desk' is the app's own note (started, stopped, exit code). */
export type LogStream = 'stdout' | 'stderr' | 'desk'

export interface LogLine {
  /** Increases by one per line within a server session. */
  seq: number
  /** Arrival time, ms since the epoch. */
  at: number
  stream: LogStream
  text: string
  event: LogEvent
}
