/**
 * What a serve session has said about itself: the startup lines, the serving line, and a few running
 * figures. A pure reducer over parsed events, used by the main process (status header, tray, snapshot).
 */
import type {
  ConcurrencyStartup,
  ContextWindowStartup,
  DrafterStartup,
  LaneKernelsStartup,
  LaneWindowsStartup,
  LoadingStartup,
  LogEvent,
  MemoryBudgetStartup,
  NoDrafterStartup,
  PromptChunksStartup,
  ResumableStartup,
  ServingEvent,
  WeightsStartup
} from './events'

export interface SessionInfo {
  memoryBudget: MemoryBudgetStartup | null
  loading: LoadingStartup | null
  laneKernels: LaneKernelsStartup | null
  laneWindows: LaneWindowsStartup | null
  drafter: DrafterStartup | null
  noDrafter: NoDrafterStartup | null
  weights: WeightsStartup | null
  promptChunks: PromptChunksStartup | null
  concurrency: ConcurrencyStartup | null
  contextWindow: ContextWindowStartup | null
  /** 0.4.0+: the longest request (prompt and reply) whose prompt is kept for its next turn. */
  resumable: ResumableStartup | null
  serving: ServingEvent | null
  notes: string[]
  /** The newer release an update notice named. */
  updateAvailable: string | null
  /** tok/s of the latest done line. */
  lastTokPerS: number | null
  done: number
  refused: number
  /** 0.4.0+: the streams waiting for memory, as the latest `memory: … wait for room` line says. */
  memoryWait: { waiting: number; streams: number } | null
  /** 0.4.0+: requests ended because memory ran short (`memory: ended …`). */
  memoryEnded: number
}

export function emptySessionInfo(): SessionInfo {
  return {
    memoryBudget: null,
    loading: null,
    laneKernels: null,
    laneWindows: null,
    drafter: null,
    noDrafter: null,
    weights: null,
    promptChunks: null,
    concurrency: null,
    contextWindow: null,
    resumable: null,
    serving: null,
    notes: [],
    updateAvailable: null,
    lastTokPerS: null,
    done: 0,
    refused: 0,
    memoryWait: null,
    memoryEnded: 0
  }
}

/** The info after one more event; the same object when the event changes nothing. */
export function applyEvent(info: SessionInfo, event: LogEvent): SessionInfo {
  switch (event.kind) {
    case 'startup':
      switch (event.what) {
        case 'memory-budget':
          return { ...info, memoryBudget: event }
        case 'loading':
          return { ...info, loading: event }
        case 'lane-kernels':
          return { ...info, laneKernels: event }
        case 'lane-windows':
          return { ...info, laneWindows: event }
        case 'drafter':
          return { ...info, drafter: event }
        case 'no-drafter':
          return { ...info, noDrafter: event }
        case 'weights':
          return { ...info, weights: event }
        case 'prompt-chunks':
          return { ...info, promptChunks: event }
        case 'concurrency':
          return { ...info, concurrency: event }
        case 'context-window':
          return { ...info, contextWindow: event }
        case 'resumable':
          return { ...info, resumable: event }
        case 'note':
          return { ...info, notes: [...info.notes, event.text] }
        default:
          return info
      }
    case 'serving':
      return { ...info, serving: event }
    case 'done':
      return event.background ? info : { ...info, lastTokPerS: event.tokPerS, done: info.done + 1 }
    case 'refused':
      return { ...info, refused: info.refused + 1 }
    case 'notice':
      switch (event.what) {
        case 'update-available':
          return { ...info, updateAvailable: String(event.fields['latest'] ?? '') }
        case 'memory-wait':
          return { ...info, memoryWait: { waiting: Number(event.fields['waiting']), streams: Number(event.fields['streams']) } }
        case 'memory-ended':
          return { ...info, memoryEnded: info.memoryEnded + 1 }
        default:
          return info
      }
    default:
      return info
  }
}

/** The drafter's short name: the Hugging Face repo when the path is in the cache, else the folder name. */
export function drafterName(info: SessionInfo): string | null {
  if (!info.drafter) return null
  return info.drafter.repo ?? info.drafter.path.split('/').filter(Boolean).pop() ?? info.drafter.path
}

/** Parallel lanes: the concurrency line's, else /health's max_batch_size. */
export function lanesOf(info: SessionInfo, maxBatchSize?: number): number | null {
  return info.concurrency?.lanes ?? maxBatchSize ?? null
}
