/**
 * The main process's service layer: what the IPC handlers, the menu and the tray call. It ties Settings,
 * the ProcessManager and the HealthPoller together. Electron-free, so it is tested with the mock.
 */
import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionResult, BinaryInfo, ServerState, SessionSnapshot } from '@shared/api'
import { buildServeArgv, buildServeEnv, formatCommandLine, type ServeConfig } from '@shared/config'
import type { LogLine } from '@shared/events'
import type { HealthSample } from '@shared/health'
import type { Settings } from '@shared/settings'
import { hasErrors, looksLikePath, validateConfig, type ValidationIssue } from '@shared/validate'
import { findBinary } from './binary'
import { HealthPoller, healthBase } from './HealthPoller'
import { describePortOwner, isPortFree } from './ports'
import { ProcessManager } from './ProcessManager'
import type { SettingsStore } from './Settings'

export interface DeskOptions {
  settings: SettingsStore
  env: NodeJS.ProcessEnv
  home: string
  logDir: string | null
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
  private binaryInfo: BinaryInfo | null = null
  private binaryKey = ''

  constructor(private readonly opts: DeskOptions) {
    super()
    const settings = opts.settings.get()
    this.manager = new ProcessManager({ logDir: opts.logDir, env: opts.env, stopGraceMs: settings.stopGraceSeconds * 1000 })
    this.health = new HealthPoller({ intervalMs: settings.healthIntervalMs })
    this.manager.on('state', (state) => {
      this.followHealth(state)
      this.emit('state', state)
    })
    this.manager.on('lines', (lines) => this.emit('lines', lines))
    this.health.on('sample', (sample) => this.emit('health', sample))
  }

  get settings(): Settings {
    return this.opts.settings.get()
  }

  setSettings(patch: Partial<Settings>): Settings {
    const next = this.opts.settings.set(patch)
    this.manager.setStopGrace(next.stopGraceSeconds * 1000)
    this.health.setInterval(next.healthIntervalMs)
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

  dispose(): void {
    this.health.stop()
    this.manager.dispose()
  }

  private followHealth(state: ServerState): void {
    const serving = state.info.serving
    if (state.status === 'serving' && serving) this.health.start(healthBase(serving.host, serving.port))
    else if (state.status !== 'serving') this.health.stop()
  }
}
