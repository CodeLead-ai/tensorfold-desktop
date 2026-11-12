/**
 * A `tensorfold serve` the app did not start, a bench script's for example: found with `ps` and `lsof`, its
 * configuration read from its command line, its log followed when its output goes to a file, and stopped when the
 * user asks (SIGTERM, then SIGKILL after the grace period). Serving means its process listens: TensorFold opens
 * its port once the model is loaded. Nothing here sends the server a request.
 */
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { ExitInfo, ServerState, ServerStatus } from '@shared/api'
import { formatCommandLine, type OtherFlag, type ServeConfig } from '@shared/config'
import type { LogLine, ServingEvent } from '@shared/events'
import { configOfCommand, parseLstart, serveCommand, sessionStart, type ExternalInfo } from '@shared/external'
import { applyEvent, emptySessionInfo } from '@shared/session'
import { parseLine } from './LogParser'
import { LineSplitter } from './lines'
import { LAST_LINES } from './ProcessManager'

export interface ProcessRow {
  pid: number
  ppid: number
  startedAt: number | null
  command: string
}

/** How the watcher looks at processes; tests give it their own. */
export interface ProcessProbe {
  processes(): Promise<ProcessRow[]>
  /** The TCP addresses each of these processes listens on. */
  listening(pids: number[]): Promise<Map<number, Array<{ host: string; port: number }>>>
  /** A process's working folder, and the file its stdout goes to (null for a terminal or a pipe). */
  files(pid: number): Promise<{ cwd: string | null; stdout: string | null }>
  alive(pid: number): boolean
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 }, (_error, stdout) => resolve(String(stdout)))
  })
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

/** macOS's ps and lsof. */
export const systemProbe: ProcessProbe = {
  async processes() {
    const out = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='])
    const rows: ProcessRow[] = []
    for (const line of out.split('\n')) {
      const m = PS_LINE.exec(line)
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: parseLstart(m[3] as string), command: m[4] as string })
    }
    return rows
  },
  async listening(pids) {
    const found = new Map<number, Array<{ host: string; port: number }>>()
    if (pids.length === 0) return found
    const out = await run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fpn'])
    let pid = 0
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      const m = /^n(.*):(\d+)$/.exec(line)
      if (m && pid) found.set(pid, [...(found.get(pid) ?? []), { host: (m[1] as string).replace(/^\[|\]$/g, ''), port: Number(m[2]) }])
    }
    return found
  },
  async files(pid) {
    const out = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'cwd,1', '-Fftn'])
    let fd = ''
    let type = ''
    let cwd: string | null = null
    let stdout: string | null = null
    for (const line of out.split('\n')) {
      if (line.startsWith('f')) fd = line.slice(1)
      else if (line.startsWith('t')) type = line.slice(1)
      else if (line.startsWith('n')) {
        if (fd === 'cwd') cwd = line.slice(1)
        if (fd === '1' && type === 'REG') stdout = line.slice(1)
      }
    }
    return { cwd, stdout }
  },
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

export interface ExternalOptions {
  /** The mock profile watches for the mock CLI only, and the real app for the real TensorFold only. */
  mock: boolean
  stopGraceMs: number
  /** The port the server form uses: a server listening there is the one shown when there are several. */
  preferredPort: () => number
  /** Flags of a newer TensorFold the app's table lacks, to read its command line. */
  others: () => OtherFlag[]
  version: (binary: string) => Promise<string | null>
  /** Processes the app started itself, never shown as outside servers. */
  own: () => number | null
  probe?: ProcessProbe
  scanMs?: number
  tailMs?: number
  /** At most this much of the log is read when the app attaches (the newest part). */
  maxReadBytes?: number
  now?: () => number
}

interface Attached {
  pid: number
  binary: string
  startedAt: number | null
  info: ExternalInfo
  tail: { file: string; pos: number; splitter: LineSplitter } | null
}

/**
 * What a server serves, from its command line: the model id TensorFold answers to (`--name`, else the folder's or the
 * repo's last part), its address, and the flags. How long it took to load is unknown.
 */
export function servingFromConfig(config: ServeConfig): ServingEvent {
  const host = config.endpoint.host || '127.0.0.1'
  const port = config.endpoint.port ?? 8080
  return {
    kind: 'serving',
    model: config.endpoint.name || config.model.replace(/\/+$/, '').split('/').pop() || config.model,
    url: `http://${host}:${port}/v1`,
    host,
    port,
    backend: 'mlx',
    sampling: {},
    greedy: false,
    drafts: config.drafting.noDrafts !== true,
    context: config.generation.context ?? null,
    loadedInS: NaN
  }
}

/** Outside servers get session ids of their own, so the window clears the previous session's lines. */
export const EXTERNAL_SESSION = 1_000_000_000

export class ExternalServer extends EventEmitter<{ state: [ServerState]; lines: [LogLine[]] }> {
  /** The outside server shown, or the last one, stopped; null when there has been none. */
  state: ServerState | null = null
  private attached: Attached | null = null
  private ring: LogLine[] = []
  private seq = 0
  private watching = false
  private busy = false
  private timer: NodeJS.Timeout | null = null
  private killTimer: NodeJS.Timeout | null = null
  private stopRequested = false
  private killed = false
  private readonly probe: ProcessProbe
  private readonly now: () => number

  constructor(private readonly opts: ExternalOptions) {
    super()
    this.probe = opts.probe ?? systemProbe
    this.now = opts.now ?? Date.now
  }

  /** Whether an outside server runs now (loading, serving or stopping). */
  get running(): boolean {
    return this.attached !== null
  }

  lines(): LogLine[] {
    return this.ring.slice()
  }

  setStopGrace(ms: number): void {
    this.opts.stopGraceMs = ms
  }

  /** Look for an outside server (on), or stop looking while the app runs its own (off). */
  watch(on: boolean): void {
    if (on === this.watching) return
    this.watching = on
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (on) void this.tick()
  }

  /** Look now (the window came back, say), instead of at the next tick. */
  refresh(): void {
    if (this.watching && !this.busy) {
      if (this.timer) clearTimeout(this.timer)
      void this.tick()
    }
  }

  /** SIGTERM, then SIGKILL once the grace period is over. False when no outside server runs. */
  stop(): boolean {
    const a = this.attached
    const state = this.state
    if (!a || !state) return false
    if (state.status !== 'stopping') {
      this.stopRequested = true
      const now = this.now()
      this.note(`stop: SIGTERM sent to pid ${a.pid} (started outside the app); SIGKILL in ${Math.round(this.opts.stopGraceMs / 1000)} s unless it has exited`)
      this.set({ status: 'stopping', stoppingSince: now, killAt: now + this.opts.stopGraceMs })
      this.send(a.pid, 'SIGTERM')
      this.killTimer = setTimeout(() => this.kill('the grace period is over'), this.opts.stopGraceMs)
    }
    return true
  }

  kill(reason = 'asked for'): boolean {
    const a = this.attached
    if (!a) return false
    this.stopRequested = true
    this.killed = true
    if (this.state?.status !== 'stopping') this.set({ status: 'stopping', stoppingSince: this.now(), killAt: this.now() })
    this.note(`SIGKILL to pid ${a.pid}: ${reason}`)
    this.send(a.pid, 'SIGKILL')
    return true
  }

  /** Another signal (SIGUSR1: a stack dump, which goes to its log), with a note. */
  signal(signal: NodeJS.Signals, note: string): boolean {
    const a = this.attached
    if (!a) return false
    this.note(note)
    return this.send(a.pid, signal)
  }

  dispose(): void {
    this.watching = false
    if (this.timer) clearTimeout(this.timer)
    if (this.killTimer) clearTimeout(this.killTimer)
    this.timer = null
  }

  private send(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }

  private schedule(): void {
    if (!this.watching) return
    const ms = this.attached ? (this.opts.tailMs ?? 1000) : (this.opts.scanMs ?? 3000)
    this.timer = setTimeout(() => void this.tick(), ms)
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.busy) return
    this.busy = true
    try {
      if (this.attached) await this.follow(this.attached)
      else await this.scan()
    } catch {
      // ps or lsof failed this time; look again at the next tick
    } finally {
      this.busy = false
      if (this.watching && !this.timer) this.schedule()
    }
  }

  private async scan(): Promise<void> {
    const own = this.opts.own()
    const candidates = (await this.probe.processes())
      .filter((p) => p.pid !== own && p.pid !== process.pid)
      .map((p) => ({ row: p, serve: serveCommand(p.command, this.opts.mock) }))
      .filter((c): c is { row: ProcessRow; serve: { binary: string; words: string[] } } => {
        if (!c.serve) return false
        // The mock profile shows the mock CLI only; the real app never shows it.
        return this.opts.mock ? /fake-tensorfold\.mjs$/.test(c.serve.binary) : !/fake-tensorfold\.mjs$/.test(c.serve.binary)
      })
    if (candidates.length === 0) return
    const listening = await this.probe.listening(candidates.map((c) => c.row.pid))
    const port = this.opts.preferredPort()
    const chosen =
      candidates.find((c) => listening.get(c.row.pid)?.some((l) => l.port === port)) ??
      candidates.find((c) => listening.has(c.row.pid)) ??
      candidates[0]
    if (!chosen) return
    await this.attach(chosen.row, chosen.serve, listening.has(chosen.row.pid))
  }

  private async attach(row: ProcessRow, serve: { binary: string; words: string[] }, listens: boolean): Promise<void> {
    const files = await this.probe.files(row.pid)
    const { argv, config } = configOfCommand(serve.words, this.opts.others())
    const version = await this.opts.version(serve.binary)
    this.attached = {
      pid: row.pid,
      binary: serve.binary,
      startedAt: row.startedAt,
      info: { cwd: files.cwd, psCommand: row.command, logFile: files.stdout },
      tail: null
    }
    this.ring = []
    this.seq = 0
    this.stopRequested = false
    this.killed = false
    this.state = {
      status: listens ? 'serving' : 'loading',
      sessionId: EXTERNAL_SESSION + row.pid,
      pid: row.pid,
      binary: serve.binary,
      version,
      config,
      argv,
      commandLine: formatCommandLine(serve.binary, argv),
      startedAt: row.startedAt,
      servingAt: null,
      stoppingSince: null,
      killAt: null,
      logFile: files.stdout,
      info: emptySessionInfo(),
      lastExit: null,
      external: this.attached.info
    }
    this.note(`found pid ${row.pid}, started outside the app${files.cwd ? ` in ${files.cwd}` : ''}: ${row.command}`)
    this.note(files.stdout ? `following its output in ${files.stdout}` : 'its output goes to a terminal or another program, so the app sees no log lines')
    if (files.stdout) this.openTail(this.attached, files.stdout)
    this.readTail(this.attached)
    this.settle(listens)
    this.emit('state', this.state)
  }

  private openTail(a: Attached, file: string): void {
    try {
      const size = statSync(file).size
      const max = this.opts.maxReadBytes ?? 32 * 1024 * 1024
      const from = Math.max(0, size - max)
      const head = this.read(file, from, size)
      const start = from + Buffer.byteLength(head.slice(0, sessionStart(head)), 'utf8')
      a.tail = { file, pos: start, splitter: new LineSplitter() }
    } catch {
      a.tail = null
    }
  }

  private read(file: string, from: number, to: number): string {
    if (to <= from) return ''
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(to - from)
      const n = readSync(fd, buffer, 0, buffer.length, from)
      return buffer.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  }

  /** New lines of the log since the last read. */
  private readTail(a: Attached): void {
    const tail = a.tail
    if (!tail) return
    let size: number
    try {
      size = statSync(tail.file).size
    } catch {
      return
    }
    if (size < tail.pos) {
      tail.pos = 0
      tail.splitter = new LineSplitter()
    }
    if (size === tail.pos) return
    const chunk = this.read(tail.file, tail.pos, size)
    tail.pos = size
    this.take(tail.splitter.push(chunk))
  }

  private take(texts: string[]): void {
    if (texts.length === 0 || !this.state) return
    const batch: LogLine[] = []
    let info = this.state.info
    for (const text of texts) {
      const event = parseLine(text)
      batch.push({ seq: ++this.seq, at: this.now(), stream: 'stdout', text, event })
      info = applyEvent(info, event)
    }
    this.push(batch)
    this.state = { ...this.state, info }
  }

  private note(text: string): void {
    this.push([{ seq: ++this.seq, at: this.now(), stream: 'desk', text, event: { kind: 'unknown', line: text } }])
  }

  private push(batch: LogLine[]): void {
    this.ring.push(...batch)
    if (this.ring.length > 20_000) this.ring.splice(0, this.ring.length - 20_000)
    this.emit('lines', batch)
  }

  /** Loading until it listens (or its log says it serves); then the time it began, as near as the log tells. */
  private settle(listens: boolean): void {
    let state = this.state
    if (!state || state.status === 'stopping') return
    // No log to read: what it serves comes from its command line once it listens.
    if (listens && !state.info.serving && state.config && !state.logFile) {
      state = this.state = { ...state, info: { ...state.info, serving: servingFromConfig(state.config) } }
    }
    const servingLine = state.info.serving
    if (state.status === 'loading' && (listens || servingLine)) {
      const loaded = servingLine && Number.isFinite(servingLine.loadedInS) && state.startedAt !== null ? state.startedAt + servingLine.loadedInS * 1000 : null
      this.state = { ...state, status: 'serving', servingAt: loaded ?? this.now() }
    } else if (state.status === 'serving' && state.servingAt === null) {
      const loaded = servingLine && Number.isFinite(servingLine.loadedInS) && state.startedAt !== null ? state.startedAt + servingLine.loadedInS * 1000 : null
      this.state = { ...state, servingAt: loaded ?? state.startedAt }
    }
  }

  private async follow(a: Attached): Promise<void> {
    const before = this.state
    if (!this.probe.alive(a.pid)) {
      this.readTail(a)
      this.detach(a)
      return
    }
    this.readTail(a)
    const listens = this.state?.status === 'loading' ? (await this.probe.listening([a.pid])).has(a.pid) : false
    this.settle(listens)
    if (this.state && (this.state !== before || this.state.info !== before?.info)) this.emit('state', this.state)
  }

  private detach(a: Attached): void {
    if (this.killTimer) clearTimeout(this.killTimer)
    this.killTimer = null
    const state = this.state
    const exit: ExitInfo = {
      code: null,
      signal: null,
      at: this.now(),
      // A server the app did not start may end for its own reasons (its script stopped it); only the app's stop counts.
      requested: true,
      killed: this.killed,
      spawnError: null,
      during: (state?.status === 'stopping' ? 'serving' : (state?.status ?? 'serving')) as ServerStatus,
      lastLines: this.ring.filter((l) => l.stream !== 'desk').slice(-LAST_LINES)
    }
    this.note(this.stopRequested ? `pid ${a.pid} has exited` : `pid ${a.pid}, started outside the app, has exited`)
    this.attached = null
    if (state) this.state = { ...state, status: 'stopped', pid: null, stoppingSince: null, killAt: null, lastExit: exit }
    if (this.state) this.emit('state', this.state)
  }

  private set(patch: Partial<ServerState>): void {
    if (!this.state) return
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }
}
