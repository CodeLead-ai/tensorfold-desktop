/**
 * The `tensorfold serve` configuration (SPEC §2.1), grouped as `tensorfold serve --help` groups it
 * (read from the installed 0.3.6.2). A flag left undefined is not passed, so TensorFold applies its own
 * default. A flag set to a value is passed even when the value equals the default: the endorsed preset
 * passes `--port 8080` and `--reasoning-effort medium`, both of which are defaults.
 */

export type ReasoningEffort = 'low' | 'medium' | 'xhigh'
export type LaneKernels = 'auto' | 'on' | 'off'
export type Backend = 'auto' | 'mlx' | 'cuda'
export type KvDtype = 'bf16' | 'int8' | 'int4'

/** endpoint */
export interface EndpointFlags {
  /** --host (default 127.0.0.1; 0.0.0.0: every interface) */
  host?: string
  /** --port (default 8080) */
  port?: number
  /** --name: the model id clients ask for (default: the model's name) */
  name?: string
  /** --alias, repeatable: more model ids to answer to */
  alias?: string[]
}

/** generation (requests can override each of these) */
export interface GenerationFlags {
  /** --context: prompt plus reply window (default: the model config) */
  context?: number
  /** --max-tokens: reply tokens when a request does not say (default 4096) */
  maxTokens?: number
  /** --temperature (default: the model's generation_config.json, else 0) */
  temperature?: number
  /** --top-p (default: the model's generation config) */
  topP?: number
  /** --top-k (default: the model's generation config) */
  topK?: number
  /** --thinking / --no-thinking (default: thinking) */
  thinking?: boolean
  /** --reasoning-effort (default medium) */
  reasoningEffort?: ReasoningEffort
  /** --thinking-budget: most thinking tokens (default 0: no limit) */
  thinkingBudget?: number
}

/** drafting and caches */
export interface DraftingFlags {
  /** --no-drafts: one token a round, the serial reference */
  noDrafts?: boolean
  /** --drafter: auto (the family's draft model when pulled), none, or a repo id or directory */
  drafter?: string
  /** --drafter-bits (default 4; 0: bf16) */
  drafterBits?: number
  /** --mtp-drafts: most MTP drafts a round (0: none) */
  mtpDrafts?: number
  /** --mtp-confidence (CUDA) */
  mtpConfidence?: number
  /** --lane-kernels (default auto) */
  laneKernels?: LaneKernels
  /** --prompt-cache-gib (0: off; default an eighth of RAM, at most 16) */
  promptCacheGib?: number
  /** --checkpoint-slots (default 3 per parallel lane, at least 8) */
  checkpointSlots?: number
  /** --spill-gib (default 0: off; needs a snapshot directory) */
  spillGib?: number
  /** --snapshot-dir (default ~/.cache/tensorfold/prefix-snapshots; 'none': in memory only) */
  snapshotDir?: string
  /** --max-snapshots: system-block snapshots loaded at start (default 3) */
  maxSnapshots?: number
  /** --parallel: a number or auto (default auto: up to 8 on a Mac) */
  parallel?: number | 'auto'
  /** --mlx-cache-gib (default 8) */
  mlxCacheGib?: number
  /** --ssd-experts GIB: stream routed experts into a GPU pool of this many GiB */
  ssdExperts?: number
  /** --ple-on-ssd (Flash Next) */
  pleOnSsd?: boolean
  /** --no-update-check */
  noUpdateCheck?: boolean
}

/** NVIDIA GPUs (DGX Spark): shown, but they do nothing on a Mac */
export interface NvidiaFlags {
  /** --backend (default auto: MLX on macOS) */
  backend?: Backend
  /** --tp */
  tp?: 1 | 2
  /** --rank */
  rank?: 0 | 1
  /** --master */
  master?: string
  /** --master-port (default 29551) */
  masterPort?: number
  /** --kv-dtype (default bf16) */
  kvDtype?: KvDtype
}

/** Environment the server reads. */
export interface ServeEnv {
  /** TENSORFOLD_MEMORY_LIMIT_GB: raises the memory budget up to the ceiling the startup line states */
  memoryLimitGb?: number
}

export interface ServeConfig {
  /** A Hugging Face repo id or a model directory (LM Studio's MLX checkpoints work as directories). */
  model: string
  endpoint: EndpointFlags
  generation: GenerationFlags
  drafting: DraftingFlags
  nvidia: NvidiaFlags
  env: ServeEnv
}

export interface FlagGroups {
  endpoint: EndpointFlags
  generation: GenerationFlags
  drafting: DraftingFlags
  nvidia: NvidiaFlags
}
export type GroupId = keyof FlagGroups

export const GROUP_TITLES: Record<GroupId, string> = {
  endpoint: 'Endpoint',
  generation: 'Generation',
  drafting: 'Drafting and caches',
  nvidia: 'NVIDIA (DGX Spark)'
}

/**
 * How a flag is written on the command line.
 * - bool: `--flag` when true, nothing otherwise
 * - tristate: `--flag` when true, `--no-flag` when false (argparse BooleanOptionalAction)
 * - list: `--flag value` once per value
 * - the rest: `--flag value`
 */
export type FlagKind = 'string' | 'int' | 'float' | 'bool' | 'tristate' | 'choice' | 'list' | 'intOrAuto'

interface FlagSpecOf<G extends GroupId, K extends keyof FlagGroups[G]> {
  group: G
  key: K
  cli: string
  kind: FlagKind
  /** The value TensorFold uses when the flag is not passed, as `serve --help` states it. */
  defaultText: string
  help: string
  choices?: readonly string[]
  /** CUDA-only, or otherwise of no effect on a Mac. */
  macNoEffect?: boolean
}

export type FlagSpec = {
  [G in GroupId]: { [K in keyof FlagGroups[G]]-?: FlagSpecOf<G, K> }[keyof FlagGroups[G]]
}[GroupId]

/** Every `tensorfold serve` flag, in `serve --help` order (which is also the order argv is built in). */
export const FLAGS: readonly FlagSpec[] = [
  { group: 'endpoint', key: 'host', cli: '--host', kind: 'string', defaultText: '127.0.0.1', help: 'address to listen on (0.0.0.0: every interface)' },
  { group: 'endpoint', key: 'port', cli: '--port', kind: 'int', defaultText: '8080', help: 'port to listen on' },
  { group: 'endpoint', key: 'name', cli: '--name', kind: 'string', defaultText: "the model's name", help: 'model id clients ask for' },
  { group: 'endpoint', key: 'alias', cli: '--alias', kind: 'list', defaultText: 'none', help: 'more model ids to answer to (one per line)' },
  { group: 'generation', key: 'context', cli: '--context', kind: 'int', defaultText: 'model config', help: 'prompt plus reply window, in tokens' },
  { group: 'generation', key: 'maxTokens', cli: '--max-tokens', kind: 'int', defaultText: '4096', help: 'reply tokens when a request does not say' },
  { group: 'generation', key: 'temperature', cli: '--temperature', kind: 'float', defaultText: 'generation_config.json, else 0', help: '0 decodes greedily' },
  { group: 'generation', key: 'topP', cli: '--top-p', kind: 'float', defaultText: 'generation config', help: 'nucleus sampling' },
  { group: 'generation', key: 'topK', cli: '--top-k', kind: 'int', defaultText: 'generation config', help: 'top-k sampling' },
  { group: 'generation', key: 'thinking', cli: '--thinking', kind: 'tristate', defaultText: 'on', help: 'open a think block when the chat template supports it' },
  { group: 'generation', key: 'reasoningEffort', cli: '--reasoning-effort', kind: 'choice', choices: ['low', 'medium', 'xhigh'], defaultText: 'medium', help: 'for chat templates that take one (Qwen3.8); medium adds no system-prompt text' },
  { group: 'generation', key: 'thinkingBudget', cli: '--thinking-budget', kind: 'int', defaultText: '0 (no limit)', help: 'most thinking tokens before the server closes the think block' },
  { group: 'drafting', key: 'noDrafts', cli: '--no-drafts', kind: 'bool', defaultText: 'drafts on', help: 'one token a round: the serial reference (same output, slower)' },
  { group: 'drafting', key: 'drafter', cli: '--drafter', kind: 'string', defaultText: 'auto', help: "auto: the family's draft model when pulled; none; or a repo id or directory" },
  { group: 'drafting', key: 'drafterBits', cli: '--drafter-bits', kind: 'int', defaultText: '4', help: "quantize the draft model's linears (0: bf16)" },
  { group: 'drafting', key: 'mtpDrafts', cli: '--mtp-drafts', kind: 'int', defaultText: 'family default', help: 'most MTP drafts a round (0: no MTP drafts)' },
  { group: 'drafting', key: 'mtpConfidence', cli: '--mtp-confidence', kind: 'float', defaultText: 'family default', help: 'on CUDA, stop an MTP chain under this probability', macNoEffect: true },
  { group: 'drafting', key: 'laneKernels', cli: '--lane-kernels', kind: 'choice', choices: ['auto', 'on', 'off'], defaultText: 'auto', help: 'lane kernels for Qwen3.8 dense (auto: on GPUs with tensor units)' },
  { group: 'drafting', key: 'promptCacheGib', cli: '--prompt-cache-gib', kind: 'float', defaultText: 'an eighth of RAM, at most 16', help: 'memory for cached conversation prefixes (0: off)' },
  { group: 'drafting', key: 'checkpointSlots', cli: '--checkpoint-slots', kind: 'int', defaultText: '3 per lane, at least 8', help: 'cached conversation prefixes kept in memory' },
  { group: 'drafting', key: 'spillGib', cli: '--spill-gib', kind: 'float', defaultText: '0 (off)', help: 'write evicted prefixes to disk, up to this many GiB (needs a snapshot directory)' },
  { group: 'drafting', key: 'snapshotDir', cli: '--snapshot-dir', kind: 'string', defaultText: '~/.cache/tensorfold/prefix-snapshots', help: "where system-block and conversation snapshots are kept ('none': in memory only)" },
  { group: 'drafting', key: 'maxSnapshots', cli: '--max-snapshots', kind: 'int', defaultText: '3', help: 'system-block snapshots loaded at start' },
  { group: 'drafting', key: 'parallel', cli: '--parallel', kind: 'intOrAuto', defaultText: 'auto', help: 'requests decoded together (Mac: up to 8 as memory allows)' },
  { group: 'drafting', key: 'mlxCacheGib', cli: '--mlx-cache-gib', kind: 'float', defaultText: '8', help: "MLX's cache of freed buffers" },
  { group: 'drafting', key: 'ssdExperts', cli: '--ssd-experts', kind: 'float', defaultText: 'off', help: 'stream routed experts into a GPU pool of this many GiB' },
  { group: 'drafting', key: 'pleOnSsd', cli: '--ple-on-ssd', kind: 'bool', defaultText: 'off', help: "Flash Next: read the n-gram tables from SSD (about 40 GiB less at peak)" },
  { group: 'drafting', key: 'noUpdateCheck', cli: '--no-update-check', kind: 'bool', defaultText: 'check', help: "don't ask GitHub whether a newer release exists" },
  { group: 'nvidia', key: 'backend', cli: '--backend', kind: 'choice', choices: ['auto', 'mlx', 'cuda'], defaultText: 'auto', help: 'auto: MLX on macOS, CUDA elsewhere', macNoEffect: true },
  { group: 'nvidia', key: 'tp', cli: '--tp', kind: 'choice', choices: ['1', '2'], defaultText: '1', help: 'GPUs (one per machine) the model is split over', macNoEffect: true },
  { group: 'nvidia', key: 'rank', cli: '--rank', kind: 'choice', choices: ['0', '1'], defaultText: '0', help: "with --tp 2: this machine's rank", macNoEffect: true },
  { group: 'nvidia', key: 'master', cli: '--master', kind: 'string', defaultText: 'none', help: "with --tp 2: rank 0's address", macNoEffect: true },
  { group: 'nvidia', key: 'masterPort', cli: '--master-port', kind: 'int', defaultText: '29551', help: "with --tp 2: rank 0's rendezvous port", macNoEffect: true },
  { group: 'nvidia', key: 'kvDtype', cli: '--kv-dtype', kind: 'choice', choices: ['bf16', 'int8', 'int4'], defaultText: 'bf16', help: 'KV cache dtype (Flash Next on CUDA only)', macNoEffect: true }
]

export function emptyConfig(model = ''): ServeConfig {
  return { model, endpoint: {}, generation: {}, drafting: {}, nvidia: {}, env: {} }
}

export function flagValue(config: ServeConfig, spec: FlagSpec): unknown {
  return (config[spec.group] as Record<string, unknown>)[spec.key]
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

/** The argv items for one flag; empty when the flag is not passed. */
export function renderFlag(spec: FlagSpec, value: unknown): string[] {
  if (isUnset(value)) return []
  switch (spec.kind) {
    case 'bool':
      return value === true ? [spec.cli] : []
    case 'tristate':
      return [value === true ? spec.cli : spec.cli.replace(/^--/, '--no-')]
    case 'list':
      return (value as string[]).filter((v) => v !== '').flatMap((v) => [spec.cli, v])
    default:
      return [spec.cli, String(value)]
  }
}

/** `serve <model> [flags]`, flags in `serve --help` order. */
export function buildServeArgv(config: ServeConfig): string[] {
  const argv = ['serve', config.model]
  for (const spec of FLAGS) argv.push(...renderFlag(spec, flagValue(config, spec)))
  return argv
}

/** The environment variables the configuration sets (only the user's; the app adds its own when spawning). */
export function buildServeEnv(config: ServeConfig): Record<string, string> {
  const env: Record<string, string> = {}
  if (config.env.memoryLimitGb !== undefined) env['TENSORFOLD_MEMORY_LIMIT_GB'] = String(config.env.memoryLimitGb)
  return env
}

const SAFE_WORD = /^[A-Za-z0-9_\-+=/.,:@%]+$/

export function shellQuote(word: string): string {
  if (word !== '' && SAFE_WORD.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** The command line as a user would type it: `ENV=value /path/to/tensorfold serve <model> --flag value`. */
export function formatCommandLine(binary: string, argv: readonly string[], env: Record<string, string> = {}): string {
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`)
  return [...assignments, shellQuote(binary), ...argv.map(shellQuote)].join(' ')
}

export class ArgvError extends Error {}

function parseNumber(spec: FlagSpec, text: string, integer: boolean): number {
  const value = Number(text)
  if (text.trim() === '' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new ArgvError(`${spec.cli} expects ${integer ? 'an integer' : 'a number'}, got ${JSON.stringify(text)}`)
  }
  return value
}

/** The inverse of buildServeArgv, for exported snapshots and pasted command lines. */
export function parseServeArgv(argv: readonly string[]): ServeConfig {
  const rest = argv[0] === 'serve' ? argv.slice(1) : argv.slice()
  const config = emptyConfig()
  const bySwitch = new Map<string, FlagSpec>()
  for (const spec of FLAGS) {
    bySwitch.set(spec.cli, spec)
    if (spec.kind === 'tristate') bySwitch.set(spec.cli.replace(/^--/, '--no-'), spec)
  }
  let model: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string
    if (!word.startsWith('--')) {
      if (model !== undefined) throw new ArgvError(`unexpected argument ${JSON.stringify(word)}`)
      model = word
      continue
    }
    const [name, inline] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    const spec = bySwitch.get(name)
    if (!spec) throw new ArgvError(`unknown flag ${name}`)
    const group = config[spec.group] as Record<string, unknown>
    if (spec.kind === 'bool') {
      group[spec.key] = true
      continue
    }
    if (spec.kind === 'tristate') {
      group[spec.key] = name === spec.cli
      continue
    }
    const text = inline ?? rest[++i]
    if (text === undefined) throw new ArgvError(`${spec.cli} needs a value`)
    switch (spec.kind) {
      case 'int':
        group[spec.key] = parseNumber(spec, text, true)
        break
      case 'float':
        group[spec.key] = parseNumber(spec, text, false)
        break
      case 'intOrAuto':
        group[spec.key] = text === 'auto' ? 'auto' : parseNumber(spec, text, true)
        break
      case 'list':
        group[spec.key] = [...((group[spec.key] as string[] | undefined) ?? []), text]
        break
      case 'choice':
        if (spec.choices && !spec.choices.includes(text)) {
          throw new ArgvError(`${spec.cli} takes ${spec.choices.join(', ')}, got ${JSON.stringify(text)}`)
        }
        group[spec.key] = spec.key === 'tp' || spec.key === 'rank' ? Number(text) : text
        break
      default:
        group[spec.key] = text
    }
  }
  if (model === undefined) throw new ArgvError('no model given')
  config.model = model
  return config
}

export interface Preset {
  id: 'endorsed' | 'serial'
  name: string
  description: string
  flags: FlagGroups
}

const ENDORSED: FlagGroups = {
  endpoint: { port: 8080 },
  generation: { context: 89600, reasoningEffort: 'medium' },
  drafting: { noUpdateCheck: true },
  nvidia: {}
}

/** SPEC §3.1. The drafter stays at auto (the default), so it is not passed. */
export const PRESETS: readonly Preset[] = [
  {
    id: 'endorsed',
    name: 'CodeLead endorsed',
    description: 'port 8080, context 89,600, reasoning effort medium, no update check; drafter auto',
    flags: ENDORSED
  },
  {
    id: 'serial',
    name: 'Serial reference',
    description: 'the endorsed flags plus --no-drafts: one token a round, the same output, slower',
    flags: { ...ENDORSED, drafting: { ...ENDORSED.drafting, noDrafts: true } }
  }
]

export type PresetId = Preset['id'] | 'custom'

function cloneGroups(flags: FlagGroups): FlagGroups {
  return JSON.parse(JSON.stringify(flags)) as FlagGroups
}

/** A preset's flags on the given model; the environment is the machine's, so it is kept. */
export function applyPreset(config: ServeConfig, id: Preset['id']): ServeConfig {
  const preset = PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error(`no preset ${id}`)
  return { model: config.model, ...cloneGroups(preset.flags), env: { ...config.env } }
}

/** The preset whose flags the configuration has exactly, else 'custom'. */
export function presetOf(config: ServeConfig): PresetId {
  const argv = buildServeArgv({ ...config, model: '' })
  for (const preset of PRESETS) {
    const presetArgv = buildServeArgv({ model: '', ...preset.flags, env: {} })
    if (argv.length === presetArgv.length && argv.every((w, i) => w === presetArgv[i])) return preset.id
  }
  return 'custom'
}
