/**
 * The app's settings (SPEC §4 Settings; README "Settings"). Kept by electron-store in the userData folder.
 * Nothing here hardcodes CodeLead's paths: the restore command starts empty and is set by the user.
 */
import { emptyConfig, type ReasoningEffort, type ServeConfig } from './config'

export type Theme = 'dark' | 'light' | 'system'

export interface ProbeSettings {
  prompt: string
  maxTokens: number
  reasoningEffort: ReasoningEffort | null
  stream: boolean
  /** The alternation set's big generation (SPEC §3.9). */
  bigPrompt: string
  bigMaxTokens: number
}

export interface Settings {
  /** The tensorfold binary; empty: find it (`which tensorfold`, then common install places). */
  binaryPath: string
  /** Folders scanned for checkpoints (LM Studio's models, the Hugging Face cache, or any folder). */
  checkpointRoots: string[]
  /** LM Studio's `lms`; empty: find it on PATH, then ~/.lmstudio/bin/lms. */
  lmsPath: string
  /** Run by "Unload LM Studio, then serve". `lms` in it means the lms found above. */
  unloadCommand: string
  /** Run by "Stop, then restore"; empty until set. */
  restoreCommand: string
  /** SIGTERM, then SIGKILL after this many seconds (TensorFold saves conversations while it stops). */
  stopGraceSeconds: number
  healthIntervalMs: number
  /** The server form, as last edited. */
  lastConfig: ServeConfig
  probe: ProbeSettings
  theme: Theme
}

export function defaultSettings(home: string): Settings {
  const config = emptyConfig(`${home}/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit`)
  config.endpoint.port = 8080
  config.generation.context = 89600
  config.generation.reasoningEffort = 'medium'
  config.drafting.noUpdateCheck = true
  return {
    binaryPath: '',
    checkpointRoots: [`${home}/.lmstudio/models`, `${home}/.cache/huggingface/hub`],
    lmsPath: '',
    unloadCommand: 'lms unload --all',
    restoreCommand: '',
    stopGraceSeconds: 30,
    healthIntervalMs: 2000,
    lastConfig: config,
    probe: {
      prompt: 'In three sentences, explain what a draft model does in speculative decoding.',
      maxTokens: 512,
      reasoningEffort: 'low',
      stream: true,
      bigPrompt: 'Write a detailed, 3,000-word technical essay on how KV caches, prefix caching and speculative decoding interact in an LLM server.',
      bigMaxTokens: 4096
    },
    theme: 'dark'
  }
}

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)

/** Settings from whatever is stored (or patched in), every field checked and defaulted. */
export function sanitizeSettings(raw: unknown, defaults: Settings): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const probe = (typeof r['probe'] === 'object' && r['probe'] !== null ? r['probe'] : {}) as Record<string, unknown>
  const lastConfig = r['lastConfig'] as ServeConfig | undefined
  const configOk =
    typeof lastConfig === 'object' &&
    lastConfig !== null &&
    typeof lastConfig.model === 'string' &&
    ['endpoint', 'generation', 'drafting', 'nvidia', 'env'].every((k) => typeof (lastConfig as unknown as Record<string, unknown>)[k] === 'object')
  const effort = probe['reasoningEffort']
  return {
    binaryPath: text(r['binaryPath'], defaults.binaryPath).trim(),
    checkpointRoots: Array.isArray(r['checkpointRoots'])
      ? r['checkpointRoots'].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : defaults.checkpointRoots,
    lmsPath: text(r['lmsPath'], defaults.lmsPath).trim(),
    unloadCommand: text(r['unloadCommand'], defaults.unloadCommand),
    restoreCommand: text(r['restoreCommand'], defaults.restoreCommand),
    stopGraceSeconds: clampNumber(r['stopGraceSeconds'], defaults.stopGraceSeconds, 1, 600),
    healthIntervalMs: clampNumber(r['healthIntervalMs'], defaults.healthIntervalMs, 500, 60_000),
    lastConfig: configOk ? (lastConfig as ServeConfig) : defaults.lastConfig,
    probe: {
      prompt: text(probe['prompt'], defaults.probe.prompt),
      maxTokens: clampNumber(probe['maxTokens'], defaults.probe.maxTokens, 1, 1_000_000),
      reasoningEffort: effort === 'low' || effort === 'medium' || effort === 'xhigh' ? effort : effort === null ? null : defaults.probe.reasoningEffort,
      stream: typeof probe['stream'] === 'boolean' ? probe['stream'] : defaults.probe.stream,
      bigPrompt: text(probe['bigPrompt'], defaults.probe.bigPrompt),
      bigMaxTokens: clampNumber(probe['bigMaxTokens'], defaults.probe.bigMaxTokens, 1, 1_000_000)
    },
    theme: r['theme'] === 'light' || r['theme'] === 'system' || r['theme'] === 'dark' ? r['theme'] : defaults.theme
  }
}
