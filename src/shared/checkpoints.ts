/**
 * The checkpoint library (SPEC §2.6, §3.6): what `tensorfold info` and `tensorfold models` print, parsed,
 * and the shape of a scan.
 */

export interface CheckpointInfo {
  modelType: string | null
  /** "Qwen3.8 dense" */
  family: string | null
  engine: string | null
  kernels: string | null
  layers: number | null
  hiddenSize: number | null
  vocab: number | null
  maxPositionEmbeddings: number | null
  quantization: string | null
  cudaFormats: string | null
  runsOn: string | null
  sampling: Record<string, number> | null
  /** Every line as printed, key to value. */
  raw: Record<string, string>
}

export interface Family {
  title: string
  modelType: string
  engines: string[]
  kernels: string | null
  /** Checkpoints TensorFold is tested with. */
  models: string[]
  drafters: string[]
}

export type CheckpointSource = 'lmstudio' | 'huggingface' | 'folder'

export interface Checkpoint {
  path: string
  source: CheckpointSource
  /** publisher/name (LM Studio) or org/name (Hugging Face) */
  repo: string | null
  /** The Hugging Face snapshot's commit. */
  sha: string | null
  sizeBytes: number
  servable: boolean
  /** Why it is not servable. */
  reason: string | null
  info: CheckpointInfo | null
  /** Its family is one `tensorfold models` lists with an engine for this machine. */
  testedFamily: boolean
  /** This very checkpoint is one the family is tested with. */
  testedCheckpoint: boolean
  /** The family's draft model and whether it is in the Hugging Face cache. */
  drafter: { repo: string; pulled: boolean } | null
  /** A draft model `tensorfold models` lists (served with a model, not on its own). */
  isDrafter: boolean
}

export interface CheckpointScan {
  at: number
  roots: Array<{ path: string; exists: boolean }>
  checkpoints: Checkpoint[]
  families: Family[]
  /** ~/.cache/tensorfold's snapshot folders, sized. */
  caches: Array<{ path: string; bytes: number; files: number }>
  /** The binary could not be asked (no binary, or `models` failed). */
  error: string | null
}

const INFO_NUMBERS: Record<string, keyof CheckpointInfo> = {
  num_hidden_layers: 'layers',
  hidden_size: 'hiddenSize',
  vocab_size: 'vocab',
  max_position_embeddings: 'maxPositionEmbeddings'
}

function pyDict(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(/'([^']*)':\s*(-?[\d.]+)/g)) out[m[1] as string] = Number(m[2])
  return out
}

/** `tensorfold info <dir>` output: `key         value` lines, keys padded to twelve columns. */
export function parseInfo(stdout: string): CheckpointInfo {
  const raw: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = /^(CUDA formats|runs on)\s+(.*)$/.exec(line) ?? /^(\S+)\s+(.*)$/.exec(line)
    if (m) raw[m[1] as string] = (m[2] as string).trim()
  }
  const family = raw['family'] ?? null
  const info: CheckpointInfo = {
    modelType: raw['model_type'] ?? null,
    family: family ? family.replace(/\s*\([^()]*\)\s*$/, '') : null,
    engine: raw['engine'] ?? null,
    kernels: raw['kernels'] ?? null,
    layers: null,
    hiddenSize: null,
    vocab: null,
    maxPositionEmbeddings: null,
    quantization: raw['quantization'] ?? null,
    cudaFormats: raw['CUDA formats'] ?? null,
    runsOn: raw['runs on'] ?? null,
    sampling: raw['sampling'] ? pyDict(raw['sampling']) : null,
    raw
  }
  for (const [key, field] of Object.entries(INFO_NUMBERS)) {
    const value = Number(raw[key])
    if (raw[key] !== undefined && Number.isFinite(value)) (info as unknown as Record<string, number>)[field] = value
  }
  return info
}

/** The reason in `tensorfold: …` on stderr, without the prefix. */
export function infoError(stderr: string): string | null {
  const lines = stderr.split('\n').filter((l) => l.trim() !== '')
  const last = [...lines].reverse().find((l) => l.startsWith('tensorfold: ')) ?? lines[lines.length - 1]
  return last ? last.replace(/^tensorfold: /, '') : null
}

/** `tensorfold models`: a family per header line, its kernels, tested models and drafters indented under it. */
export function parseModels(stdout: string): Family[] {
  const families: Family[] = []
  let current: Family | null = null
  for (const line of stdout.split('\n')) {
    const header = /^(\S.*?) \(([\w.]+); (.+)\)$/.exec(line)
    if (header) {
      current = { title: header[1] as string, modelType: header[2] as string, engines: (header[3] as string).split(', '), kernels: null, models: [], drafters: [] }
      families.push(current)
      continue
    }
    const item = /^\s+(kernels|model|drafter)\s+(\S+)\s*$/.exec(line)
    if (!item || !current) continue
    if (item[1] === 'kernels') current.kernels = item[2] as string
    else if (item[1] === 'model') current.models.push(item[2] as string)
    else current.drafters.push(item[2] as string)
  }
  return families
}

/** The family of a model type that has an engine for this platform (MLX on a Mac). */
export function familyFor(families: readonly Family[], modelType: string | null, platform: string): Family | null {
  if (!modelType) return null
  const wanted = platform === 'darwin' ? 'MLX' : 'CUDA'
  return families.find((f) => f.modelType === modelType && f.engines.some((e) => e.includes(wanted))) ?? null
}
