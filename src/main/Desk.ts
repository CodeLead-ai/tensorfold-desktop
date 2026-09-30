/**
 * The main process's service layer: what the IPC handlers, the menu and the tray call. It ties Settings,
 * the ProcessManager and the HealthPoller together. Electron-free, so it is tested with the mock.
 */
import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionResult, BinaryInfo, LogsInfo, ServerState, SessionSnapshot, SnapshotResult, StepsResult } from '@shared/api'
import type { CheckpointScan } from '@shared/checkpoints'
import { buildServeArgv, buildServeEnv, formatCommandLine, type ServeConfig } from '@shared/config'
import type { LogLine } from '@shared/events'
import type { HealthSample } from '@shared/health'
import type { CommandResult, LmStudioStatus } from '@shared/lmstudio'
import type { ProbeRequest, ProbeResult } from '@shared/probe'
import type { PullState } from '@shared/pull'
import type { Settings } from '@shared/settings'
import { runnerLines } from '@shared/snapshot'
import { hasErrors, looksLikePath, validateConfig, type ValidationIssue } from '@shared/validate'
import { findBinary } from './binary'
import { Checkpoints } from './Checkpoints'
import { LmStudio } from './LmStudio'
import { logStats, pruneLogs } from './logRetention'
import { runProbe } from './Probe'
import { Puller } from './Pull'
import { writeSnapshot } from './SnapshotWriter'
import { HealthPoller, healthBase } from './HealthPoller'
import { describePortOwner, isPortFree } from './ports'
import { ProcessManager } from './ProcessManager'
import type { SettingsStore } from './Settings'

export interface DeskOptions {
  settings: SettingsStore
  env: NodeJS.ProcessEnv
  home: string
  logDir: string | null
  /** Where exported serving snapshots go. */
  snapshotDir: string | null
  /** Where `tensorfold info` answers are cached. */
  infoCacheFile: string | null
  /** Whether LM Studio runs; the process list when not given. */
  lmStudioRunning?: () => Promise<boolean>
  mockBinary: string | null
  mock: boolean
  appVersion: string
  platform: string
}

interface DeskEvents {
  state: [ServerState]
  lines: [LogLine[]]
  health: [HealthSample]
  settings: [Settings]
  pull: [PullState]
}

export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** The configuration as it will run: `~` expanded, the model trimmed. */
export function normalizeConfig(config: ServeConfig, home: string): ServeConfig {
  return { ...config, model: expandHome(config.model.trim(), home) }
}

export class Desk extends EventEmitter<DeskEvents> {
  readonly manager: ProcessManager
  readonly health: HealthPoller
  readonly checkpoints: Checkpoints
  readonly puller: Puller
  readonly lm: LmStudio
  private binaryInfo: BinaryInfo | null = null
  private binaryKey = ''

  constructor(private readonly opts: DeskOptions) {
    super()
    const settings = opts.settings.get()
    this.manager = new ProcessManager({ logDir: opts.logDir, keepLogs: settings.keepLogs, env: opts.env, stopGraceMs: settings.stopGraceSeconds * 1000 })
    this.health = new HealthPoller({ intervalMs: settings.healthIntervalMs })
    this.manager.on('state', (state) => {
      this.followHealth(state)
      this.emit('state', state)
    })
    this.manager.on('lines', (lines) => this.emit('lines', lines))
    this.health.on('sample', (sample) => this.emit('health', sample))
    this.checkpoints = new Checkpoints({ cacheFile: opts.infoCacheFile, env: opts.env, platform: opts.platform, home: opts.home })
    this.puller = new Puller(opts.env)
    this.puller.on('update', (state) => this.emit('pull', state))
    this.lm = new LmStudio({ env: opts.env, home: opts.home, ...(opts.lmStudioRunning ? { isRunning: opts.lmStudioRunning } : {}) })
  }

  get settings(): Settings {
    return this.opts.settings.get()
  }

  setSettings(patch: Partial<Settings>): Settings {
    const next = this.opts.settings.set(patch)
    this.manager.setStopGrace(next.stopGraceSeconds * 1000)
    this.health.setInterval(next.healthIntervalMs)
    this.manager.setKeepLogs(next.keepLogs)
    if (this.opts.logDir) pruneLogs(this.opts.logDir, next.keepLogs, this.manager.state.logFile)
    this.emit('settings', next)
    return next
  }

  session(): SessionSnapshot {
    return {
      state: this.manager.state,
      lines: this.manager.lines(),
      health: this.health.latest,
      mock: this.opts.mock,
      appVersion: this.opts.appVersion,
      platform: this.opts.platform,
      logDir: this.opts.logDir
    }
  }

  /** For the screenshot run: an environment variable for the next server started (e.g. a mock failure). */
  setChildEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete this.opts.env[key]
    else this.opts.env[key] = value
  }

  /** The binary, found once per configured path (Settings can change it). */
  async binary(refresh = false): Promise<BinaryInfo> {
    const key = this.settings.binaryPath
    if (!refresh && this.binaryInfo && this.binaryKey === key && this.binaryInfo.path) return this.binaryInfo
    this.binaryInfo = await findBinary({ configured: key, mockBinary: this.opts.mockBinary, env: this.opts.env, home: this.opts.home })
    this.binaryKey = key
    return this.binaryInfo
  }

  async previewCommand(config: ServeConfig): Promise<string> {
    const normalized = normalizeConfig(config, this.opts.home)
    const binary = (await this.binary()).path ?? 'tensorfold'
    return formatCommandLine(binary, buildServeArgv(normalized), buildServeEnv(normalized))
  }

  /** The form's checks, plus the ones that need the disk and the network. */
  async validate(config: ServeConfig): Promise<ValidationIssue[]> {
    const normalized = normalizeConfig(config, this.opts.home)
    const issues = validateConfig(normalized, this.opts.platform)
    const model = normalized.model
    if (model !== '' && looksLikePath(model)) {
      if (!existsSync(model)) issues.push({ field: 'model', message: 'no such folder', severity: 'error' })
      else if (!statSync(model).isDirectory()) issues.push({ field: 'model', message: 'not a folder', severity: 'error' })
      else if (!existsSync(join(model, 'config.json'))) {
        issues.push({ field: 'model', message: 'the folder has no config.json (GGUF checkpoints are not servable by TensorFold)', severity: 'error' })
      }
    }
    const port = normalized.endpoint.port ?? 8080
    const host = normalized.endpoint.host || '127.0.0.1'
    const ours = this.manager.running && (this.manager.state.config?.endpoint.port ?? 8080) === port
    if (!ours && Number.isInteger(port) && port > 0 && port < 65536 && !(await isPortFree(port, host))) {
      issues.push({ field: 'endpoint.port', message: await describePortOwner(port, host), severity: 'error' })
    }
    return issues
  }

  async start(config: ServeConfig): Promise<ActionResult> {
    if (this.manager.running) return { ok: false, error: `the server is ${this.manager.state.status}` }
    const normalized = normalizeConfig(config, this.opts.home)
    const issues = await this.validate(normalized)
    if (hasErrors(issues)) return { ok: false, error: 'the configuration has errors', issues }
    const binary = await this.binary(true)
    if (!binary.path || binary.error) return { ok: false, error: binary.error ?? 'no tensorfold binary' }
    this.opts.settings.set({ lastConfig: config })
    try {
      this.manager.start({ binary: binary.path, config: normalized, version: binary.version })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true }
  }

  async stop(): Promise<ActionResult> {
    if (!this.manager.running) return { ok: false, error: 'the server is not running' }
    await this.manager.stop()
    return { ok: true }
  }

  kill(): ActionResult {
    if (!this.manager.running) return { ok: false, error: 'the server is not running' }
    this.manager.kill()
    return { ok: true }
  }

  async restart(config: ServeConfig): Promise<ActionResult> {
    if (this.manager.running) await this.manager.stop()
    return this.start(config)
  }

  async listCheckpoints(refresh = false): Promise<CheckpointScan> {
    return this.checkpoints.scan(await this.binary(refresh), this.settings.checkpointRoots, refresh)
  }

  async pull(repo: string): Promise<ActionResult> {
    const binary = await this.binary()
    if (!binary.path) return { ok: false, error: binary.error ?? 'no tensorfold binary' }
    return this.puller.start(binary.path, repo)
  }

  lmStudioStatus(): Promise<LmStudioStatus> {
    return this.lm.status(this.settings.lmsPath)
  }

  /** SPEC §2.5: unload what LM Studio has loaded (its memory counts against the budget), then serve. */
  async unloadAndServe(config: ServeConfig): Promise<StepsResult> {
    const steps: CommandResult[] = []
    if (this.manager.running) return { ok: false, error: `the server is ${this.manager.state.status}`, steps }
    const issues = await this.validate(config)
    if (hasErrors(issues)) return { ok: false, error: 'the configuration has errors; LM Studio was left as it is', steps, issues }
    const settings = this.settings
    const before = await this.lm.status(settings.lmsPath)
    if (before.running && !before.available) return { ok: false, error: before.error ?? 'LM Studio is not available', steps }
    if (before.models.length > 0) {
      const unload = await this.lm.run(settings.unloadCommand, settings.lmsPath, 5 * 60_000)
      steps.push(unload)
      if (!unload.ok) return { ok: false, error: `the unload command failed (${unload.error}); the server was not started`, steps }
      const after = await this.lm.status(settings.lmsPath)
      if (after.models.length > 0) {
        return { ok: false, error: `LM Studio still has ${after.models.map((m) => m.identifier).join(', ')} loaded; the server was not started`, steps }
      }
    }
    const started = await this.start(config)
    return started.ok ? { ok: true, error: null, steps } : { ok: false, error: started.error, steps, ...(started.issues ? { issues: started.issues } : {}) }
  }

  /** SPEC §2.5: stop the server, then run the user's restore command (it reloads LM Studio). */
  async stopAndRestore(): Promise<StepsResult> {
    const steps: CommandResult[] = []
    const settings = this.settings
    if (!settings.restoreCommand.trim()) return { ok: false, error: 'no restore command is set (Settings, LM Studio)', steps }
    if (this.manager.running) await this.manager.stop()
    const restore = await this.lm.run(settings.restoreCommand, settings.lmsPath)
    steps.push(restore)
    return { ok: restore.ok, error: restore.ok ? null : `the restore command failed (${restore.error})`, steps }
  }

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const state = this.manager.state
    const serving = state.info.serving
    if (state.status !== 'serving' || !serving) {
      return {
        label: request.label ?? 'probe', ok: false, error: 'the server is not serving', status: null, startedAt: Date.now(), totalS: 0,
        ttftS: null, promptTokens: null, completionTokens: null, tokPerS: null, finish: null, server: null, replyPreview: ''
      }
    }
    return runProbe({ base: healthBase(serving.host, serving.port), model: serving.model, manager: this.manager }, request)
  }

  /** SPEC §3.10: the running (or last) configuration as JSON. */
  exportSnapshot(): SnapshotResult {
    const state = this.manager.state
    if (!state.config || !state.info.serving) return { ok: false, error: 'nothing to export yet: start the server first' }
    if (!this.opts.snapshotDir) return { ok: false, error: 'no folder for snapshots' }
    const latest = this.health.latest
    return { ok: true, ...writeSnapshot(this.opts.snapshotDir, state, latest?.ok ? latest.health.memory : null, this.opts.appVersion) }
  }

  runnerLines(): string | null {
    return runnerLines(this.manager.state)
  }

  logsInfo(): LogsInfo {
    const dir = this.opts.logDir
    return { dir, ...(dir ? logStats(dir) : { files: 0, bytes: 0 }), keep: this.settings.keepLogs }
  }

  dispose(): void {
    this.health.stop()
    this.puller.cancel()
    this.manager.dispose()
  }

  private followHealth(state: ServerState): void {
    const serving = state.info.serving
    if (state.status === 'serving' && serving) this.health.start(healthBase(serving.host, serving.port))
    else if (state.status !== 'serving') this.health.stop()
  }
}
