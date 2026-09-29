/**
 * Checks on a serve configuration that need no I/O (SPEC §3.1: context is a positive integer, and the
 * rest of the flags' ranges). The main process adds the checks that do: the model folder has a
 * config.json, and the port is free.
 */
import { FLAGS, type ServeConfig } from './config'

export interface ValidationIssue {
  /** `model`, `env.memoryLimitGb`, or `<group>.<key>` of a flag. */
  field: string
  message: string
  severity: 'error' | 'warning'
}

const REPO_ID = /^[\w.-]+\/[\w.-]+$/

export function looksLikePath(model: string): boolean {
  return model.startsWith('/') || model.startsWith('~') || model.startsWith('.')
}

export function isRepoId(model: string): boolean {
  return REPO_ID.test(model)
}

type Rule = (value: number) => string | null

const integer: Rule = (v) => (Number.isInteger(v) ? null : 'must be a whole number')
const positive: Rule = (v) => (v > 0 ? null : 'must be more than 0')
const nonNegative: Rule = (v) => (v >= 0 ? null : 'must be 0 or more')
const fraction: Rule = (v) => (v > 0 && v <= 1 ? null : 'must be more than 0 and at most 1')
const probability: Rule = (v) => (v >= 0 && v <= 1 ? null : 'must be between 0 and 1')
const portRange: Rule = (v) => (v >= 1 && v <= 65535 ? null : 'must be between 1 and 65535')

const NUMBER_RULES: Record<string, Rule[]> = {
  'endpoint.port': [integer, portRange],
  'generation.context': [integer, positive],
  'generation.maxTokens': [integer, positive],
  'generation.temperature': [nonNegative],
  'generation.topP': [fraction],
  'generation.topK': [integer, nonNegative],
  'generation.thinkingBudget': [integer, nonNegative],
  'drafting.drafterBits': [integer, nonNegative],
  'drafting.mtpDrafts': [integer, nonNegative],
  'drafting.mtpConfidence': [probability],
  'drafting.promptCacheGib': [nonNegative],
  'drafting.checkpointSlots': [integer, positive],
  'drafting.spillGib': [nonNegative],
  'drafting.maxSnapshots': [integer, nonNegative],
  'drafting.mlxCacheGib': [nonNegative],
  'drafting.ssdExperts': [positive],
  'nvidia.masterPort': [integer, portRange]
}

export function validateConfig(config: ServeConfig, platform: string = 'darwin'): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const error = (field: string, message: string): void => void issues.push({ field, message, severity: 'error' })
  const warning = (field: string, message: string): void => void issues.push({ field, message, severity: 'warning' })

  const model = config.model.trim()
  if (model === '') error('model', 'choose a model folder or enter a Hugging Face repo id')
  else if (!looksLikePath(model) && !isRepoId(model)) error('model', 'neither a folder path nor a Hugging Face repo id (owner/name)')
  else if (!looksLikePath(model)) warning('model', 'a repo id is downloaded from Hugging Face on first use unless it is in the cache')

  for (const spec of FLAGS) {
    const field = `${spec.group}.${String(spec.key)}`
    const value = (config[spec.group] as Record<string, unknown>)[spec.key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        error(field, 'must be a number')
        continue
      }
      for (const rule of NUMBER_RULES[field] ?? []) {
        const message = rule(value)
        if (message) {
          error(field, message)
          break
        }
      }
    }
    if (spec.key === 'parallel' && value !== 'auto' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
      error(field, 'must be auto or a whole number of at least 1')
    }
    if (spec.key === 'host' && (typeof value !== 'string' || /\s/.test(value))) error(field, 'must be an address without spaces')
    if (spec.macNoEffect && platform === 'darwin') warning(field, 'does nothing on a Mac (NVIDIA only)')
  }

  const { spillGib, snapshotDir } = config.drafting
  if (spillGib !== undefined && spillGib > 0 && snapshotDir === 'none') {
    error('drafting.spillGib', "needs a snapshot directory (--snapshot-dir is 'none')")
  }
  const { context, maxTokens } = config.generation
  if (context !== undefined && maxTokens !== undefined && maxTokens >= context) {
    warning('generation.maxTokens', 'the default reply is as long as the whole context window')
  }
  const host = config.endpoint.host
  if (host !== undefined && host !== '' && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    warning('endpoint.host', 'listening beyond this Mac makes the server reachable from the network')
  }
  const limit = config.env.memoryLimitGb
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) error('env.memoryLimitGb', 'must be more than 0')

  return issues
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}
