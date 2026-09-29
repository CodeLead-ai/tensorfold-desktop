/**
 * Scans the checkpoint folders (SPEC §2.6): LM Studio's `<publisher>/<name>/` folders, the Hugging Face cache's
 * `models--<org>--<name>/snapshots/<sha>/`, or any folder holding checkpoints. Every folder with a config.json
 * is asked `tensorfold info` (it reads config.json only, safe while serving), cached per path, config.json
 * mtime and binary version. GGUF-only folders are listed as not servable.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { BinaryInfo } from '@shared/api'
import {
  familyFor,
  infoError,
  parseInfo,
  parseModels,
  type Checkpoint,
  type CheckpointScan,
  type CheckpointSource,
  type Family
} from '@shared/checkpoints'
import { isScript } from './ProcessManager'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

interface Candidate {
  path: string
  source: CheckpointSource
  repo: string | null
  sha: string | null
  hasConfig: boolean
  gguf: boolean
}

export interface CheckpointsOptions {
  /** Where `info` answers are cached; null: in memory only. */
  cacheFile: string | null
  env: NodeJS.ProcessEnv
  platform: string
  home: string
}

export function runTensorfold(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<RunResult> {
  const script = isScript(binary)
  const quiet = { ...env, PYTHONDONTWRITEBYTECODE: '1', TENSORFOLD_NO_UPDATE_CHECK: '1', ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  const [command, argv] = script ? [process.execPath, [binary, ...args]] : [binary, args]
  return new Promise((resolve) => {
    execFile(command, argv, { env: quiet, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && typeof error.code !== 'number' ? error.message : '') })
    })
  })
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && safeIsDir(join(path, d.name))))
      .map((d) => join(path, d.name))
  } catch {
    return []
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function files(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Bytes on disk under a folder (Hugging Face snapshot files are links into blobs; stat follows them). */
export function folderBytes(path: string, limit = 20_000): { bytes: number; files: number } {
  let bytes = 0
  let count = 0
  const stack = [path]
  while (stack.length && count < limit) {
    const dir = stack.pop() as string
    for (const name of files(dir)) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) stack.push(full)
        else {
          bytes += st.size
          count++
        }
      } catch {
        // a dangling link
      }
    }
  }
  return { bytes, files: count }
}

export function hubCacheDir(env: NodeJS.ProcessEnv, home: string): string {
  return env['HF_HUB_CACHE'] || (env['HF_HOME'] ? join(env['HF_HOME'], 'hub') : join(home, '.cache', 'huggingface', 'hub'))
}

/** The candidates under one root. */
export function findCandidates(root: string): Candidate[] {
  if (!safeIsDir(root)) return []
  const top = dirs(root)
  const hub = top.filter((d) => /\/models--[^/]+--[^/]+$/.test(d))
  if (hub.length > 0) {
    const out: Candidate[] = []
    for (const repoDir of hub) {
      const name = repoDir.split('/').pop() as string
      const rest = name.slice('models--'.length)
      const cut = rest.indexOf('--')
      const repo = `${rest.slice(0, cut)}/${rest.slice(cut + 2)}`
      for (const snapshot of dirs(join(repoDir, 'snapshots'))) {
        const has = files(snapshot)
        out.push({ path: snapshot, source: 'huggingface', repo, sha: snapshot.split('/').pop() ?? null, hasConfig: has.includes('config.json'), gguf: has.some((f) => f.endsWith('.gguf')) })
      }
    }
    return out
  }
  const lmstudio = /\/\.lmstudio\/models\/?$/.test(root) || /lmstudio/i.test(root)
  const out: Candidate[] = []
  const walk = (dir: string, depth: number): void => {
    const names = files(dir)
    const hasConfig = names.includes('config.json')
    const gguf = names.some((f) => f.endsWith('.gguf'))
    if (hasConfig || gguf) {
      const rel = relative(root, dir)
      out.push({ path: dir, source: lmstudio ? 'lmstudio' : 'folder', repo: rel.split('/').length === 2 ? rel : null, sha: null, hasConfig, gguf })
      return
    }
    if (depth >= 3) return
    for (const sub of dirs(dir)) walk(sub, depth + 1)
  }
  walk(root, 0)
  return out
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return out
}

export class Checkpoints {
  private cache: Record<string, { key: string; result: RunResult }> = {}
  private models: { key: string; families: Family[]; error: string | null } | null = null

  constructor(private readonly opts: CheckpointsOptions) {
    if (opts.cacheFile && existsSync(opts.cacheFile)) {
      try {
        this.cache = JSON.parse(readFileSync(opts.cacheFile, 'utf8')) as typeof this.cache
      } catch {
        this.cache = {}
      }
    }
  }

  private save(): void {
    if (!this.opts.cacheFile) return
    mkdirSync(dirname(this.opts.cacheFile), { recursive: true })
    writeFileSync(this.opts.cacheFile, JSON.stringify(this.cache))
  }

  private async families(binary: BinaryInfo, refresh: boolean): Promise<{ families: Family[]; error: string | null }> {
    const key = `${binary.path}|${binary.version}`
    if (!refresh && this.models?.key === key) return this.models
    const result = await runTensorfold(binary.path as string, ['models'], this.opts.env)
    this.models = { key, families: result.code === 0 ? parseModels(result.stdout) : [], error: result.code === 0 ? null : (infoError(result.stderr) ?? 'tensorfold models failed') }
    return this.models
  }

  private async info(binary: BinaryInfo, path: string, refresh: boolean): Promise<RunResult> {
    let mtime = 0
    try {
      mtime = statSync(join(path, 'config.json')).mtimeMs
    } catch {
      // no config.json: tensorfold says so below
    }
    const key = `${binary.path}|${binary.version}|${mtime}`
    const hit = this.cache[path]
    if (!refresh && hit && hit.key === key) return hit.result
    const result = await runTensorfold(binary.path as string, ['info', path], this.opts.env)
    this.cache[path] = { key, result }
    return result
  }

  /** Every checkpoint under the roots, servable first. */
  async scan(binary: BinaryInfo, roots: string[], refresh = false): Promise<CheckpointScan> {
    const at = Date.now()
    const rootInfo = roots.map((path) => ({ path, exists: safeIsDir(path) }))
    const caches = ['prefix-snapshots', 'session-snapshots'].map((name) => {
      const path = join(this.opts.home, '.cache', 'tensorfold', name)
      return { path, ...folderBytes(path) }
    })
    if (!binary.path) return { at, roots: rootInfo, checkpoints: [], families: [], caches, error: binary.error ?? 'no tensorfold binary' }

    const { families, error } = await this.families(binary, refresh)
    const drafters = new Set(families.flatMap((f) => f.drafters))
    const hubDirs = [hubCacheDir(this.opts.env, this.opts.home), ...roots]
    const pulled = (repo: string): boolean =>
      hubDirs.some((dir) => dirs(join(dir, `models--${repo.replace('/', '--')}`, 'snapshots')).some((s) => files(s).some((f) => f.endsWith('.safetensors'))))

    const seen = new Set<string>()
    const candidates = roots.flatMap(findCandidates).filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
    const checkpoints = await mapLimit(candidates, 4, async (c): Promise<Checkpoint> => {
      const size = folderBytes(c.path).bytes
      const isDrafter = c.repo !== null && drafters.has(c.repo)
      const base = { path: c.path, source: c.source, repo: c.repo, sha: c.sha, sizeBytes: size, isDrafter, testedFamily: false, testedCheckpoint: false, drafter: null }
      if (!c.hasConfig) {
        return { ...base, servable: false, info: null, reason: c.gguf ? 'GGUF: TensorFold serves MLX (safetensors) checkpoints' : 'no config.json' }
      }
      const result = await this.info(binary, c.path, refresh)
      const info = parseInfo(result.stdout)
      const family = familyFor(families, info.modelType, this.opts.platform)
      const servable = result.code === 0
      return {
        ...base,
        servable,
        info: result.stdout.trim() ? info : null,
        reason: servable ? null : isDrafter ? 'a draft model: TensorFold serves it next to its model' : (infoError(result.stderr) ?? `tensorfold info exited with ${result.code}`),
        testedFamily: family !== null,
        testedCheckpoint: family !== null && c.repo !== null && family.models.includes(c.repo),
        drafter: family && family.drafters[0] ? { repo: family.drafters[0], pulled: pulled(family.drafters[0]) } : null
      }
    })
    this.save()
    checkpoints.sort((a, b) => Number(b.servable) - Number(a.servable) || Number(b.isDrafter) - Number(a.isDrafter) || (a.repo ?? a.path).localeCompare(b.repo ?? b.path))
    return { at, roots: rootInfo, checkpoints, families, caches, error }
  }
}
