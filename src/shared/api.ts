/**
 * The contract between the main process and the renderer: state types and the API the preload script
 * exposes as `window.tfdesk` (SPEC §4 Preload). The renderer makes no network calls; everything goes
 * through here.
 */
import type { CheckpointScan } from './checkpoints'
import type { ServeConfig } from './config'
import type { LogLine } from './events'
import type { HealthSample } from './health'
import type { CommandResult, LmStudioStatus } from './lmstudio'
import type { ProbeRequest, ProbeResult } from './probe'
import type { PullState } from './pull'
import type { HelpFlag } from './serveHelp'
import type { SessionInfo } from './session'
import type { Settings } from './settings'
import type { UpdateCheck } from './update'
import type { ValidationIssue } from './validate'

/** SPEC §3.1: stopped → loading → serving → stopping → stopped. */
export type ServerStatus = 'stopped' | 'loading' | 'serving' | 'stopping'

export interface ExitInfo {
  code: number | null
  signal: string | null
  at: number
  /** The app asked the server to stop (else it died). */
  requested: boolean
  /** SIGKILL was needed after the grace period, or asked for. */
  killed: boolean
  /** The binary did not start at all (ENOENT, EACCES, …). */
  spawnError: string | null
  /** The status the server was in when it ended. */
  during: ServerStatus
  /** The last 50 lines of stdout and stderr. */
  lastLines: LogLine[]
}

export interface ServerState {
  status: ServerStatus
  /** Increases with each start; the renderer clears its session data when it changes. */
  sessionId: number
  pid: number | null
  binary: string | null
  version: string | null
  config: ServeConfig | null
  argv: string[]
  /** The exact command line, copyable. */
  commandLine: string
  startedAt: number | null
  servingAt: number | null
  stoppingSince: number | null
  /** When SIGKILL follows if the server has not exited. */
  killAt: number | null
  /** The app's copy of this session's log. */
  logFile: string | null
  info: SessionInfo
  lastExit: ExitInfo | null
}

export type ActionResult = { ok: true } | { ok: false; error: string; issues?: ValidationIssue[] }

/** A sequence of user commands (LM Studio's unload or restore) and what came of it. */
export interface StepsResult {
  ok: boolean
  error: string | null
  steps: CommandResult[]
  issues?: ValidationIssue[]
}

export type SnapshotResult = { ok: true; path: string; json: string } | { ok: false; error: string }

/** A request the renderer made, and whether the network guard let it through (SPEC §6.8). */
export interface AuditEntry {
  at: number
  url: string
  allowed: boolean
}

export interface BinaryInfo {
  path: string | null
  source: 'settings' | 'path' | 'found' | 'mock' | null
  version: string | null
  error: string | null
  /** Places looked at, in order. */
  searched: string[]
  /** The flags its `serve --help` lists, in order; null when it could not be read. */
  serveHelp: HelpFlag[] | null
}

export interface SessionSnapshot {
  state: ServerState
  lines: LogLine[]
  health: HealthSample | null
  mock: boolean
  appVersion: string
  platform: string
  /** Where session logs are written. */
  logDir: string | null
}

/** The session logs in <userData>/logs, and the cap on them. */
export interface LogsInfo {
  dir: string | null
  files: number
  bytes: number
  keep: number
}

export type Unsubscribe = () => void

export interface DeskApi {
  getSession(): Promise<SessionSnapshot>
  startServer(config: ServeConfig): Promise<ActionResult>
  stopServer(): Promise<ActionResult>
  restartServer(config: ServeConfig): Promise<ActionResult>
  /** SIGKILL now. */
  killServer(): Promise<ActionResult>
  /** Every check, including the ones that need the disk and the network (config.json, port free). */
  validateConfig(config: ServeConfig): Promise<ValidationIssue[]>
  onState(cb: (state: ServerState) => void): Unsubscribe
  onLines(cb: (lines: LogLine[]) => void): Unsubscribe
  onHealth(cb: (sample: HealthSample) => void): Unsubscribe
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  detectBinary(): Promise<BinaryInfo>
  copyText(text: string): Promise<void>
  /** Show a file or folder in Finder. */
  reveal(path: string): Promise<void>
  chooseFile(options: { title: string; directory: boolean; defaultPath?: string }): Promise<string | null>
  /** The command line for a configuration with the current binary, as the preview shows it. */
  previewCommand(config: ServeConfig): Promise<string>
  /** The main process asks for a view (the menu-bar item, the screenshot run). */
  onNavigate(cb: (view: string) => void): Unsubscribe
  listCheckpoints(refresh: boolean): Promise<CheckpointScan>
  pull(repo: string): Promise<ActionResult>
  cancelPull(): Promise<void>
  getPull(): Promise<PullState | null>
  onPull(cb: (state: PullState) => void): Unsubscribe
  lmStudioStatus(): Promise<LmStudioStatus>
  unloadAndServe(config: ServeConfig): Promise<StepsResult>
  stopAndRestore(): Promise<StepsResult>
  probe(request: ProbeRequest): Promise<ProbeResult>
  exportSnapshot(): Promise<SnapshotResult>
  /** CODELEAD_BASE_URL and CODELEAD_MODEL lines, or null when nothing is serving. */
  runnerLines(): Promise<string | null>
  networkAudit(): Promise<AuditEntry[]>
  logsInfo(): Promise<LogsInfo>
  /** `tensorfold update --check`: the CLI asks GitHub whether a newer release exists. Installs nothing. */
  checkUpdate(): Promise<UpdateCheck>
  /** SIGUSR1: TensorFold prints every thread's Python stack on stderr (the Log view shows it). */
  dumpStacks(): Promise<ActionResult>
}

export const CHANNELS = {
  getSession: 'session:get',
  start: 'server:start',
  stop: 'server:stop',
  restart: 'server:restart',
  kill: 'server:kill',
  validate: 'server:validate',
  state: 'server:state',
  lines: 'server:lines',
  health: 'server:health',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  detectBinary: 'binary:detect',
  copyText: 'clipboard:write',
  reveal: 'shell:reveal',
  chooseFile: 'dialog:choose',
  previewCommand: 'server:preview',
  navigate: 'app:navigate',
  listCheckpoints: 'checkpoints:list',
  pull: 'pull:start',
  cancelPull: 'pull:cancel',
  getPull: 'pull:get',
  pullUpdate: 'pull:update',
  lmStatus: 'lms:status',
  unloadAndServe: 'lms:unload-and-serve',
  stopAndRestore: 'lms:stop-and-restore',
  probe: 'probe:run',
  exportSnapshot: 'snapshot:export',
  runnerLines: 'snapshot:runner',
  networkAudit: 'audit:list',
  logsInfo: 'logs:info',
  checkUpdate: 'binary:update-check',
  dumpStacks: 'server:dump-stacks'
} as const
