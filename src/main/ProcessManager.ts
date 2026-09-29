/**
 * Runs one `tensorfold serve` child (SPEC §3.1, §4): spawn with argv from a typed config, read stdout and
 * stderr line by line through the LogParser, keep the state machine
 *   stopped → loading → serving → stopping → stopped,
 * stop with SIGTERM then SIGKILL after a grace period, and keep the exit code and the last 50 lines.
 * Every line also goes to this session's log file. No Electron here, so it runs under vitest.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { ExitInfo, ServerState, ServerStatus } from '@shared/api'
import { buildServeArgv, buildServeEnv, formatCommandLine, type ServeConfig } from '@shared/config'
import type { LogLine, LogStream } from '@shared/events'
import { applyEvent, emptySessionInfo } from '@shared/session'
import { parseLine } from './LogParser'
import { LineSplitter } from './lines'

export const LAST_LINES = 50

export interface ProcessManagerOptions {
  /** Where each session's log copy goes; null: no copy. */
  logDir: string | null
  /** The environment children start from (the login shell's). */
  env: NodeJS.ProcessEnv
  /** SIGTERM, then SIGKILL after this long. TensorFold saves conversations while it stops. */
  stopGraceMs: number
  /** Lines kept in memory for the log view. */
  maxLines?: number
  /** Lines are handed on in batches this far apart. */
  batchMs?: number
  now?: () => number
}

export interface StartOptions {
  binary: string
  config: ServeConfig
  version?: string | null
}

interface ManagerEvents {
  state: [ServerState]
  lines: [LogLine[]]
}

/** A JavaScript "binary" (the mock) runs under Electron's own Node, so no system node is needed. */
export function isScript(binary: string): boolean {
  return /\.(mjs|cjs|js)$/.test(binary)
}

/** Local time as a file name: 2026-09-29T13-50-12. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

export function describeExit(exit: ExitInfo): string {
  if (exit.spawnError) return `could not start: ${exit.spawnError}`
  if (exit.signal) return `terminated by ${exit.signal}${exit.killed ? ' (SIGKILL after the grace period or on request)' : ''}`
  return `exited with code ${exit.code}`
}

export function initialState(): ServerState {
  return {
    status: 'stopped',
    sessionId: 0,
    pid: null,
    binary: null,
    version: null,
    config: null,
    argv: [],
    commandLine: '',
    startedAt: null,
    servingAt: null,
    stoppingSince: null,
    killAt: null,
    logFile: null,
    info: emptySessionInfo(),
    lastExit: null
  }
}

export class ProcessManager extends EventEmitter<ManagerEvents> {
  state: ServerState = initialState()
  private child: ChildProcess | null = null
  private ring: LogLine[] = []
  private pending: LogLine[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private killTimer: NodeJS.Timeout | null = null
  private logStream: WriteStream | null = null
  private seq = 0
  private stopRequested = false
  private killed = false
  private finished = true
  /** loading or serving: what the server was doing before it was asked to stop. */
  private phase: ServerStatus = 'stopped'
  private waiters: Array<(exit: ExitInfo) => void> = []
  private readonly now: () => number

  constructor(private readonly opts: ProcessManagerOptions) {
    super()
    this.now = opts.now ?? Date.now
  }

  /** The lines of the current (or last) session. */
  lines(): LogLine[] {
    return this.ring.slice()
  }

  get running(): boolean {
    return this.state.status !== 'stopped'
  }

  setStopGrace(ms: number): void {
    this.opts.stopGraceMs = ms
  }

  start({ binary, config, version = null }: StartOptions): void {
    if (this.state.status !== 'stopped') throw new Error(`the server is already ${this.state.status}`)
    const argv = buildServeArgv(config)
    const userEnv = buildServeEnv(config)
    const commandLine = formatCommandLine(binary, argv, userEnv)
    const startedAt = this.now()

    this.ring = []
    this.pending = []
    this.seq = 0
    this.stopRequested = false
    this.killed = false
    this.finished = false
    this.phase = 'loading'
    let logFile: string | null = null
    if (this.opts.logDir) {
      mkdirSync(this.opts.logDir, { recursive: true })
      logFile = join(this.opts.logDir, `${stamp(startedAt)}.log`)
      this.logStream = createWriteStream(logFile, { flags: 'a' })
      this.logStream.on('error', () => (this.logStream = null))
    }
    this.setState({
      status: 'loading',
      sessionId: this.state.sessionId + 1,
      pid: null,
      binary,
      version,
      config,
      argv,
      commandLine,
      startedAt,
      servingAt: null,
      stoppingSince: null,
      killAt: null,
      logFile,
      info: emptySessionInfo()
    })
    this.desk(`start: ${commandLine}`)

    const script = isScript(binary)
    const env: NodeJS.ProcessEnv = {
      ...this.opts.env,
      ...userEnv,
      // Access lines are printed without a flush; unbuffered, every line arrives when it is written.
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      // 0.4.0's live status line redraws in a terminal only; keep it off for a pipe anyway.
      TENSORFOLD_NO_LIVE: '1',
      ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {})
    }
    let child: ChildProcess
    try {
      child = script
        ? spawn(process.execPath, [binary, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(binary, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      this.finish(null, null, e instanceof Error ? e.message : String(e))
      return
    }
    this.child = child
    const out = new LineSplitter()
    const err = new LineSplitter()
    child.stdout?.on('data', (chunk: Buffer) => this.take('stdout', out.push(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.take('stderr', err.push(chunk)))
    child.on('error', (e) => {
      if (child.pid === undefined) this.finish(null, null, e.message)
    })
    child.on('close', (code, signal) => {
      this.take('stdout', out.end())
      this.take('stderr', err.end())
      this.finish(code, signal, null)
    })
    if (child.pid !== undefined) this.setState({ pid: child.pid })
  }

  /** SIGTERM, then SIGKILL once the grace period is over. Resolves with the exit. */
  stop(): Promise<ExitInfo | null> {
    if (this.state.status === 'stopped' || !this.child) return Promise.resolve(this.state.lastExit)
    const done = new Promise<ExitInfo>((resolve) => this.waiters.push(resolve))
    if (this.state.status !== 'stopping') {
      this.stopRequested = true
      const now = this.now()
      this.setState({ status: 'stopping', stoppingSince: now, killAt: now + this.opts.stopGraceMs })
      this.desk(`stop: SIGTERM sent; SIGKILL in ${Math.round(this.opts.stopGraceMs / 1000)} s unless it has exited`)
      this.child.kill('SIGTERM')
      this.killTimer = setTimeout(() => this.kill('the grace period is over'), this.opts.stopGraceMs)
    }
    return done
  }

  /** SIGKILL now. */
  kill(reason = 'asked for'): void {
    if (this.state.status === 'stopped' || !this.child) return
    this.stopRequested = true
    this.killed = true
    if (this.state.status !== 'stopping') this.setState({ status: 'stopping', stoppingSince: this.now(), killAt: this.now() })
    this.desk(`SIGKILL: ${reason}`)
    this.child.kill('SIGKILL')
  }

  async restart(options: StartOptions): Promise<void> {
    await this.stop()
    this.start(options)
  }

  /** On app quit: no child outlives the app. */
  dispose(): void {
    if (this.child && this.state.status !== 'stopped') this.child.kill('SIGKILL')
  }

  private take(stream: LogStream, texts: string[]): void {
    if (texts.length === 0) return
    let info = this.state.info
    let servingAt = this.state.servingAt
    let status = this.state.status
    for (const text of texts) {
      const event = parseLine(text)
      this.push({ seq: ++this.seq, at: this.now(), stream, text, event })
      this.logStream?.write(`${text}\n`)
      info = applyEvent(info, event)
      if (event.kind === 'serving' && status === 'loading') {
        status = 'serving'
        servingAt = this.now()
        this.phase = 'serving'
      }
    }
    if (info !== this.state.info || status !== this.state.status) this.setState({ info, status, servingAt })
  }

  private desk(text: string): void {
    this.push({ seq: ++this.seq, at: this.now(), stream: 'desk', text, event: { kind: 'unknown', line: text } })
    this.logStream?.write(`[desk] ${text}\n`)
  }

  private push(line: LogLine): void {
    this.ring.push(line)
    const max = this.opts.maxLines ?? 20_000
    if (this.ring.length > max) this.ring.splice(0, this.ring.length - max)
    this.pending.push(line)
    this.flushTimer ??= setTimeout(() => this.flush(), this.opts.batchMs ?? 40)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    this.emit('lines', batch)
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, spawnError: string | null): void {
    if (this.finished) return
    this.finished = true
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = null
    const exit: ExitInfo = {
      code,
      signal,
      at: this.now(),
      requested: this.stopRequested,
      killed: this.killed,
      spawnError,
      during: this.phase,
      lastLines: this.ring.filter((l) => l.stream !== 'desk').slice(-LAST_LINES)
    }
    this.desk(describeExit(exit))
    this.flush()
    this.logStream?.end()
    this.logStream = null
    this.child = null
    this.phase = 'stopped'
    this.setState({ status: 'stopped', pid: null, stoppingSince: null, killAt: null, lastExit: exit })
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve(exit)
  }

  private setState(patch: Partial<ServerState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }
}
