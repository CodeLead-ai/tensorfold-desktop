/**
 * The serving snapshot (SPEC §3.10): the running configuration as JSON, the bench's serving-config record.
 * It holds every flag (passed or not), and configFromSnapshot rebuilds the command line from it.
 */
import type { ServerState } from './api'
import {
  FLAGS,
  buildServeArgv,
  buildServeEnv,
  emptyConfig,
  flagValue,
  formatCommandLine,
  renderFlag,
  type ServeConfig
} from './config'
import type { HealthMemory } from './health'
import { drafterName } from './session'

export interface SnapshotFlag {
  group: string
  value: unknown
  passed: boolean
  default: string
}

export interface ServingSnapshot {
  kind: 'tensorfold-serving-config'
  schema: 1
  exportedAt: string
  startedAt: string | null
  servingAt: string | null
  tensorfold: { version: string | null; binary: string | null }
  commandLine: string
  argv: string[]
  env: Record<string, string>
  flags: Record<string, SnapshotFlag>
  checkpoint: { path: string; repo: string | null; sha: string | null; configSha256: string | null }
  drafter: { name: string | null; path: string; repo: string | null; sha: string | null; block: number; bits: number } | null
  serving: {
    model: string
    url: string
    context: number | null
    sampling: Record<string, number>
    greedy: boolean
    drafts: boolean
    loadedInS: number
    family: string | null
    modelType: string | null
    lanes: number | null
  } | null
  memory: { sentence: string | null; budgetGib: number | null; mlxGib: number | null; ceilingGib: number | null; health: HealthMemory | null }
  machine: { chip: string; memoryGiB: number; os: string }
  app: { name: string; version: string }
  /** For a CodeLead runner. */
  runner: Record<string, string> | null
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

/** `CODELEAD_BASE_URL` and `CODELEAD_MODEL` for the serving server (SPEC §3.10, "copy for a runner"). */
export function runnerEnv(state: ServerState): Record<string, string> | null {
  const serving = state.info.serving
  if (!serving) return null
  const host = serving.host === '0.0.0.0' || serving.host === '::' ? '127.0.0.1' : serving.host
  return { CODELEAD_BASE_URL: `http://${host}:${serving.port}/v1`, CODELEAD_MODEL: serving.model }
}

export function runnerLines(state: ServerState): string | null {
  const env = runnerEnv(state)
  return env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') : null
}

function checkpointRepo(path: string): { repo: string | null; sha: string | null } {
  const hub = /models--([^/]+?)--([^/]+)\/snapshots\/([0-9a-f]+)/.exec(path)
  if (hub) return { repo: `${hub[1]}/${hub[2]}`, sha: hub[3] as string }
  const lm = /\/\.lmstudio\/models\/([^/]+\/[^/]+)\/?$/.exec(path)
  return { repo: lm ? (lm[1] as string) : null, sha: null }
}

export function buildSnapshot(input: {
  state: ServerState
  health: HealthMemory | null
  exportedAt: number
  appVersion: string
  machine: ServingSnapshot['machine']
  configSha256: string | null
}): ServingSnapshot {
  const { state } = input
  const config = state.config ?? emptyConfig()
  const flags: Record<string, SnapshotFlag> = {}
  for (const spec of FLAGS) {
    const value = flagValue(config, spec)
    flags[spec.cli] = { group: spec.group, value: value === undefined ? null : value, passed: renderFlag(spec, value).length > 0, default: spec.defaultText }
  }
  const info = state.info
  const serving = info.serving
  return {
    kind: 'tensorfold-serving-config',
    schema: 1,
    exportedAt: new Date(input.exportedAt).toISOString(),
    startedAt: iso(state.startedAt),
    servingAt: iso(state.servingAt),
    tensorfold: { version: state.version, binary: state.binary },
    commandLine: state.commandLine,
    argv: state.argv,
    env: buildServeEnv(config),
    flags,
    checkpoint: { path: config.model, ...checkpointRepo(config.model), configSha256: input.configSha256 },
    drafter: info.drafter
      ? { name: drafterName(info), path: info.drafter.path, repo: info.drafter.repo, sha: info.drafter.sha, block: info.drafter.block, bits: info.drafter.bits }
      : null,
    serving: serving
      ? {
          model: serving.model,
          url: serving.url,
          context: serving.context,
          sampling: serving.sampling,
          greedy: serving.greedy,
          drafts: serving.drafts,
          loadedInS: serving.loadedInS,
          family: info.loading?.family ?? null,
          modelType: info.loading?.modelType ?? null,
          lanes: info.concurrency?.lanes ?? null
        }
      : null,
    memory: {
      sentence: info.memoryBudget?.sentence ?? null,
      budgetGib: info.memoryBudget?.budgetGib ?? null,
      mlxGib: info.memoryBudget?.mlxGib ?? null,
      ceilingGib: info.memoryBudget?.ceilingGib ?? null,
      health: input.health
    },
    machine: input.machine,
    app: { name: 'TensorFold Desk', version: input.appVersion },
    runner: runnerEnv(state)
  }
}

/** The configuration a snapshot records, from its flags alone. */
export function configFromSnapshot(snapshot: ServingSnapshot): ServeConfig {
  const config = emptyConfig(snapshot.checkpoint.path)
  for (const spec of FLAGS) {
    const flag = snapshot.flags[spec.cli]
    if (flag?.passed) (config[spec.group] as Record<string, unknown>)[spec.key] = flag.value
  }
  const limit = snapshot.env['TENSORFOLD_MEMORY_LIMIT_GB']
  if (limit !== undefined) config.env.memoryLimitGb = Number(limit)
  return config
}

/** The command line a snapshot's flags reproduce (it equals snapshot.commandLine). */
export function reproduceCommandLine(snapshot: ServingSnapshot): string {
  const config = configFromSnapshot(snapshot)
  return formatCommandLine(snapshot.tensorfold.binary ?? 'tensorfold', buildServeArgv(config), buildServeEnv(config))
}
