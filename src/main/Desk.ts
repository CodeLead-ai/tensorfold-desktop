/**
 * The main process's service layer: what the IPC handlers, the menu and the tray call. It ties Settings,
 * the ProcessManager and the HealthPoller together. Electron-free, so it is tested with the mock.
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionResult, BinaryInfo, LogsInfo, ServerState, SessionSnapshot, SnapshotResult, StepsResult } from '@shared/api'
import type { CheckpointScan } from '@shared/checkpoints'
import { buildServeArgv, buildServeEnv, formatCommandLine, type ServeConfig } from '@shared/config'
import type { LogLine } from '@shared/events'
import type { HealthSample } from '@shared/health'
import type { CommandResult, LmStudioStatus } from '@shared/lmstudio'
import type { ProbeRequest, ProbeResult } from '@shared/probe'
import type { PullState } from '@shared/pull'
import { helpSwitches, otherFlags } from '@shared/serveHelp'
import type { Settings } from '@shared/settings'
import { runnerLines } from '@shared/snapshot'
import type { UpdateCheck } from '@shared/update'
import { hasErrors, looksLikePath, validateConfig, type ValidationIssue } from '@shared/validate'
import { findBinary, runVersion, signalsReachPython } from './binary'
import { Checkpoints } from './Checkpoints'
import { LmStudio } from './LmStudio'
import { logStats, pruneLogs } from './logRetention'
import { runProbe } from './Probe'
import { Puller } from './Pull'
import { writeSnapshot } from './SnapshotWriter'
import { HealthPoller, healthBase } from './HealthPoller'
import { describePortOwner, isPortAvailable } from './ports'
import { ExternalServer, type ProcessProbe } from './External'
import { ProcessManager } from './ProcessManager'
import type { SettingsStore } from './Settings'
import { runUpdateCheck } from './UpdateCheck'

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
  /** Show a `tensorfold serve` the app did not start (default on; tests turn it on when they need it). */
  watchExternal?: boolean
  /** How the outside-server watcher looks at processes (tests). */
  processProbe?: ProcessProbe
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

/** Whether a checkpoint's config.json has the vision tower's config (TensorFold's check for --vision). */
function hasVisionConfig(configPath: string): boolean {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const vision = config['vision_config']
    return typeof vision === 'object' && vision !== null && Object.keys(vision).length > 0
  } catch {
    return true // unreadable here: TensorFold says what is wrong
  }
}

export class Desk extends EventEmitter<DeskEvents> {
  readonly manager: ProcessManager
  readonly health: HealthPoller
  readonly checkpoints: Checkpoints
  readonly puller: Puller
  readonly lm: LmStudio
  /** A `tensorfold serve` the app did not start. */
  readonly external: ExternalServer
  private binaryInfo: BinaryInfo | null = null
  private binaryKey = ''
  /** Which server the window shows: the app's own (or none), or the outside one, the last to appear. */
  private shown: 'own' | 'external' = 'own'
  /** The window is on screen: an outside server's /health is read only then (each read is a line in its log). */
  private visible = true
  private readonly versions = new Map<string, Promise<string | null>>()

  constructor(private readonly opts: DeskOptions) {
    super()
    const settings = opts.settings.get()
    this.manager = new ProcessManager({ logDir: opts.logDir, keepLogs: settings.keepLogs, env: opts.env, stopGraceMs: settings.stopGraceSeconds * 1000 })
    this.health = new HealthPoller({ intervalMs: settings.healthIntervalMs })
    this.external = new ExternalServer({
      mock: opts.mock,
      stopGraceMs: settings.stopGraceSeconds * 1000,
      preferredPort: () => this.settings.lastConfig.endpoint.port ?? 8080,
      others: () => otherFlags(this.binaryInfo?.serveHelp ?? null),
      version: (binary) => this.versionOf(binary),
      own: () => this.manager.state.pid,
      ...(opts.processProbe ? { probe: opts.processProbe } : {})
    })
    this.manager.on('state', (state) => {
      if (this.manager.running) this.shown = 'own'
      this.external.watch(!this.manager.running && opts.watchExternal !== false)
      if (this.shown === 'own') this.publish(state)
    })
    this.manager.on('lines', (lines) => this.shown === 'own' && this.emit('lines', lines))
    this.external.on('state', (state) => {
      if (this.manager.running) return
      const switched = this.shown !== 'external'
      this.shown = 'external'
      // The state first: the window clears the previous session's lines when the session changes.
      this.publish(state)
      if (switched) this.emit('lines', this.external.lines())
    })
    this.external.on('lines', (lines) => this.shown === 'external' && this.emit('lines', lines))
    this.external.watch(opts.watchExternal !== false)
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
    this.external.setStopGrace(next.stopGraceSeconds * 1000)
    this.health.setInterval(next.healthIntervalMs)
    this.manager.setKeepLogs(next.keepLogs)
    if (this.opts.logDir) pruneLogs(this.opts.logDir, next.keepLogs, this.manager.state.logFile)
    this.emit('settings', next)
    return next
  }

  /** The server the window shows: the app's own, or one it did not start. */
  get state(): ServerState {
    return this.shown === 'external' && this.external.state ? this.external.state : this.manager.state
  }

  /** Whether the shown server runs (the app's own, or an outside one). */
  get running(): boolean {
    return this.manager.running || (this.shown === 'external' && this.external.running)
  }

  /** The window was shown or hidden: an outside server's /health is read only while it is shown. */
  setWindowVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (visible) this.external.refresh()
    this.followHealth(this.state)
  }

  session(): SessionSnapshot {
    const external = this.shown === 'external' && this.external.state !== null
    return {
      state: this.state,
      lines: external ? this.external.lines() : this.manager.lines(),
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

  /** The form's checks, the flags the installed version has, and the checks that need the disk and the network. */
  async validate(config: ServeConfig): Promise<ValidationIssue[]> {
    const normalized = normalizeConfig(config, this.opts.home)
    const binary = await this.binary()
    const flags = binary.serveHelp ? { version: binary.version, switches: helpSwitches(binary.serveHelp) } : null
    const issues = validateConfig(normalized, this.opts.platform, flags)
    const model = normalized.model
    if (model !== '' && looksLikePath(model)) {
      if (!existsSync(model)) issues.push({ field: 'model', message: 'no such folder', severity: 'error' })
      else if (!statSync(model).isDirectory()) issues.push({ field: 'model', message: 'not a folder', severity: 'error' })
      else if (!existsSync(join(model, 'config.json'))) {
        issues.push({ field: 'model', message: 'the folder has no config.json (GGUF checkpoints are not servable by TensorFold)', severity: 'error' })
      } else if (normalized.endpoint.vision === true && !hasVisionConfig(join(model, 'config.json'))) {
        issues.push({ field: 'endpoint.vision', message: 'this checkpoint has no vision_config: --vision needs a vision-language checkpoint', severity: 'error' })
      }
    }
    const port = normalized.endpoint.port ?? 8080
    const host = normalized.endpoint.host || '127.0.0.1'
    const ours = this.manager.running && (this.manager.state.config?.endpoint.port ?? 8080) === port
    if (!ours && Number.isInteger(port) && port > 0 && port < 65536 && !(await isPortAvailable(port, host))) {
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

  /** Stops the shown server: the app's own, or, once the user has confirmed it, one it did not start. */
  async stop(): Promise<ActionResult> {
    if (this.manager.running) {
      await this.manager.stop()
      return { ok: true }
    }
    if (this.shown === 'external' && this.external.running) {
      this.external.stop()
      return { ok: true }
    }
    return { ok: false, error: 'the server is not running' }
  }

  kill(): ActionResult {
    if (this.manager.running) this.manager.kill()
    else if (this.shown === 'external' && this.external.running) this.external.kill()
    else return { ok: false, error: 'the server is not running' }
    return { ok: true }
  }

  /**
   * SIGUSR1: TensorFold (0.3.6.2 and 0.5.0 alike) prints every thread's Python stack on stderr. It arms the dump
   * before it sizes its memory budget, so the budget line is the sign it is safe: before that, SIGUSR1's default
   * action would end the process.
   */
  dumpStacks(): ActionResult {
    const state = this.state
    if (state.status !== 'serving' && state.status !== 'loading') return { ok: false, error: 'the server is not running' }
    if (state.status === 'loading' && !state.info.memoryBudget) {
      return { ok: false, error: 'not yet: TensorFold arms its stack dump just before its memory budget line, and SIGUSR1 would end it before then' }
    }
    if (!state.binary || !signalsReachPython(state.binary)) {
      return { ok: false, error: `${state.binary ?? 'the binary'} is not a Python entry point, so SIGUSR1 might not reach TensorFold: send it to the Python process yourself (kill -USR1 <pid>)` }
    }
    const note = `SIGUSR1 sent: TensorFold prints every thread's stack on stderr${state.external ? (state.external.logFile ? ', into its log' : ', where its output goes') : ''}`
    const sent = state.external ? this.external.signal('SIGUSR1', note) : this.manager.signal('SIGUSR1', note)
    return sent ? { ok: true } : { ok: false, error: 'the server is not running' }
  }

  /** `tensorfold update --check` with the binary in use. The CLI asks GitHub; nothing is installed. */
  async checkUpdate(): Promise<UpdateCheck> {
    const binary = await this.binary()
    if (!binary.path || binary.error) {
      return { at: Date.now(), ok: false, current: binary.version, latest: null, newer: false, command: 'tensorfold update', notesUrl: null, error: binary.error ?? 'no tensorfold binary', output: '' }
    }
    return runUpdateCheck(binary.path, this.opts.env)
  }

  async restart(config: ServeConfig): Promise<ActionResult> {
    if (this.manager.running) await this.manager.stop()
    else if (this.shown === 'external' && this.external.running) {
      this.external.stop()
      const deadline = Date.now() + this.settings.stopGraceSeconds * 1000 + 5000
      while (this.external.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
    }
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
    if (this.running) return { ok: false, error: `the server is ${this.state.status}`, steps }
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
    const state = this.state
    const serving = state.info.serving
    if (state.status !== 'serving' || !serving) {
      return {
        label: request.label ?? 'probe', ok: false, error: 'the server is not serving', status: null, startedAt: Date.now(), totalS: 0,
        ttftS: null, promptTokens: null, completionTokens: null, tokPerS: null, finish: null, server: null, replyPreview: ''
      }
    }
    return runProbe({ base: healthBase(serving.host, serving.port), model: serving.model, lines: this }, request)
  }

  /** SPEC §3.10: the running (or last) configuration as JSON. */
  exportSnapshot(): SnapshotResult {
    const state = this.state
    if (!state.config || !state.info.serving) return { ok: false, error: 'nothing to export yet: start the server first' }
    if (!this.opts.snapshotDir) return { ok: false, error: 'no folder for snapshots' }
    const latest = this.health.latest
    return { ok: true, ...writeSnapshot(this.opts.snapshotDir, state, latest?.ok ? latest.health.memory : null, this.opts.appVersion) }
  }

  runnerLines(): string | null {
    return runnerLines(this.state)
  }

  logsInfo(): LogsInfo {
    const dir = this.opts.logDir
    return { dir, ...(dir ? logStats(dir) : { files: 0, bytes: 0 }), keep: this.settings.keepLogs }
  }

  dispose(): void {
    this.health.stop()
    this.puller.cancel()
    this.external.dispose()
    this.manager.dispose()
  }

  /** The shown server's state, and /health followed for it (an outside server's only while the window is shown). */
  private publish(state: ServerState): void {
    this.followHealth(state)
    this.emit('state', state)
  }

  private followHealth(state: ServerState): void {
    const serving = state.info.serving
    const read = state.status === 'serving' && serving !== null && (state.external === null || this.visible)
    if (read && serving) this.health.start(healthBase(serving.host, serving.port))
    else this.health.stop()
  }

  /** `--version` of an outside server's binary, asked once per binary. */
  private versionOf(binary: string): Promise<string | null> {
    let version = this.versions.get(binary)
    if (!version) {
      version = runVersion(binary, this.opts.env)
      this.versions.set(binary, version)
    }
    return version
  }
}
