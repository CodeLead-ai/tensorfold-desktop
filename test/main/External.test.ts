import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyPreset, emptyConfig } from '@shared/config'
import { EXTERNAL_SESSION, ExternalServer, type ProcessProbe, type ProcessRow } from '../../src/main/External'

const MODEL = '/Users/peter/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit'
const BIN = '/Users/peter/Projects/codelead-bench/tensorfold-venv/bin/tensorfold'
const ARGS = `${BIN} serve ${MODEL} --port 8080 --context 89600 --reasoning-effort medium --no-update-check`
const STARTED = new Date(2026, 10, 7, 8, 25, 15).getTime()
const ENDORSED = readFileSync(join(__dirname, '..', 'fixtures', 'serve-log-0.5.0-endorsed-2026-09-30.txt'), 'utf8')
const DONE =
  '[tensorfold] done req-acbb439bb025 prompt=36743 cached=0 thinking=True effort=low tokens=16 sha=8cffff2e5f66 finish=length tok/s=36.0 ttft=59.08s prefill=59.02s rounds=4 accepted=11/30 ms/round=82.9 forward=82.9 draft=0.0 post=0.0 rows=8.5 checkpoints=1 (2.49 GiB, hits=0 misses=1 evictions=0)'

const dir = mkdtempSync(join(tmpdir(), 'tfdesk-external-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const children: ChildProcess[] = []
const watchers: ExternalServer[] = []
afterEach(() => {
  for (const w of watchers.splice(0)) w.dispose()
  for (const c of children.splice(0)) c.kill('SIGKILL')
})

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A real process to stand for the server, so the signals sent to it go somewhere harmless. */
function stand(): { pid: number; alive: () => boolean } {
  const child = spawn('/bin/sleep', ['60'])
  children.push(child)
  let alive = true
  child.on('exit', () => (alive = false))
  return { pid: child.pid as number, alive: () => alive }
}

function watcher(probe: ProcessProbe, preferredPort = 8080): ExternalServer {
  const w = new ExternalServer({ mock: false, stopGraceMs: 2000, preferredPort: () => preferredPort, others: () => [], version: async () => '0.5.0', own: () => null, probe, scanMs: 20, tailMs: 20 })
  watchers.push(w)
  return w
}

describe('a server the app did not start', () => {
  it("shows the bench's server: its configuration, the log's current session, and the time it began serving", async () => {
    const server = stand()
    const log = join(dir, 'bench.log')
    writeFileSync(log, `[tensorfold] memory budget 44.8 GiB: an earlier session\n[tensorfold] serving old …\n${ENDORSED}`)
    const rows: ProcessRow[] = [
      { pid: 999_001, ppid: server.pid, startedAt: STARTED, command: `caffeinate -i -s ${ARGS}` },
      { pid: server.pid, ppid: 1, startedAt: STARTED, command: `/opt/homebrew/Cellar/python@3.14/3.14.6/Resources/Python.app/Contents/MacOS/Python ${ARGS}` },
      { pid: 999_002, ppid: 1, startedAt: STARTED, command: '/usr/local/bin/node /x/mock/fake-tensorfold.mjs serve /x/m --port 9000' }
    ]
    const w = watcher({
      processes: async () => rows,
      listening: async (pids) => new Map(pids.includes(server.pid) ? [[server.pid, [{ host: '127.0.0.1', port: 8080 }]]] : []),
      files: async () => ({ cwd: '/Users/peter/Projects/codelead-bench', stdout: log }),
      alive: (pid) => pid === server.pid && server.alive()
    })
    w.watch(true)
    await until(() => w.state?.status === 'serving')
    expect(w.state).toMatchObject({
      pid: server.pid,
      sessionId: EXTERNAL_SESSION + server.pid,
      version: '0.5.0',
      binary: BIN,
      config: applyPreset(emptyConfig(MODEL), 'endorsed'),
      startedAt: STARTED,
      servingAt: STARTED + 34_800,
      logFile: log,
      external: { cwd: '/Users/peter/Projects/codelead-bench', logFile: log }
    })
    expect(w.state?.info.serving).toMatchObject({ model: 'Qwen3.8-27B-MLX-8bit', port: 8080, loadedInS: 34.8 })
    expect(w.state?.info.resumable?.tokens).toBe(49664)
    // Only the current session's lines, not the earlier one's.
    expect(w.lines().filter((l) => l.stream !== 'desk').map((l) => l.text)).toEqual(ENDORSED.split('\n').filter(Boolean))

    appendFileSync(log, `${DONE}\n`)
    await until(() => w.lines().some((l) => l.event.kind === 'done'))
    expect(w.state?.info.done).toBe(1)

    expect(w.stop()).toBe(true)
    expect(w.state?.status).toBe('stopping')
    await until(() => w.state?.status === 'stopped')
    expect(w.running).toBe(false)
    expect(w.state?.lastExit).toMatchObject({ code: null, signal: null, requested: true, killed: false })
    expect(w.lines().map((l) => l.text).filter((t) => /SIGTERM sent to pid|has exited/.test(t))).toHaveLength(2)
  })

  it('without a log, takes what it serves from its command line once it listens', async () => {
    const server = stand()
    let listens = false
    const w = watcher({
      processes: async () => [{ pid: server.pid, ppid: 1, startedAt: STARTED, command: `/x/Python ${ARGS}` }],
      listening: async () => new Map(listens ? [[server.pid, [{ host: '127.0.0.1', port: 8080 }]]] : []),
      files: async () => ({ cwd: null, stdout: null }),
      alive: () => server.alive()
    })
    w.watch(true)
    await until(() => w.state?.status === 'loading')
    expect(w.state?.info.serving).toBeNull()
    listens = true
    await until(() => w.state?.status === 'serving')
    expect(w.state?.info.serving).toMatchObject({ model: 'Qwen3.8-27B-MLX-8bit', host: '127.0.0.1', port: 8080, context: 89600, drafts: true })
    expect(Number.isNaN(w.state?.info.serving?.loadedInS)).toBe(true)
    expect(w.state?.external?.logFile).toBeNull()
  })

  it('prefers the one on the form\'s port, and never shows its own process', async () => {
    const a = stand()
    const b = stand()
    const command = (port: number): string => `/x/Python ${BIN} serve /m --port ${port}`
    const probe: ProcessProbe = {
      processes: async () => [
        { pid: a.pid, ppid: 1, startedAt: STARTED, command: command(8080) },
        { pid: b.pid, ppid: 1, startedAt: STARTED, command: command(8081) }
      ],
      listening: async () => new Map([[a.pid, [{ host: '127.0.0.1', port: 8080 }]], [b.pid, [{ host: '127.0.0.1', port: 8081 }]]]),
      files: async () => ({ cwd: null, stdout: null }),
      alive: () => true
    }
    const w = watcher(probe, 8081)
    w.watch(true)
    await until(() => w.state !== null)
    expect(w.state?.pid).toBe(b.pid)
    const mine = new ExternalServer({ mock: false, stopGraceMs: 1000, preferredPort: () => 8081, others: () => [], version: async () => null, own: () => b.pid, probe, scanMs: 20 })
    watchers.push(mine)
    mine.watch(true)
    await until(() => mine.state !== null)
    expect(mine.state?.pid).toBe(a.pid)
  })
})
