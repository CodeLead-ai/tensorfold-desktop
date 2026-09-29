import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { ServerState } from '@shared/api'
import { applyPreset, emptyConfig } from '@shared/config'
import type { LogLine } from '@shared/events'
import { ProcessManager } from '../../src/main/ProcessManager'
import { FAST_MOCK_ENV, MOCK, MOCK_MODEL, freePort } from '../helpers'

const logDir = mkdtempSync(join(tmpdir(), 'tfdesk-pm-'))
afterAll(() => rmSync(logDir, { recursive: true, force: true }))

const managers: ProcessManager[] = []
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose()
})

function manager(env: Record<string, string> = {}, stopGraceMs = 5000): ProcessManager {
  const m = new ProcessManager({ logDir, env: { ...process.env, ...FAST_MOCK_ENV, ...env }, stopGraceMs, batchMs: 5 })
  managers.push(m)
  return m
}

async function config(port?: number) {
  const c = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
  c.endpoint.port = port ?? (await freePort())
  return c
}

function until(m: ProcessManager, predicate: (s: ServerState) => boolean, timeoutMs = 10_000): Promise<ServerState> {
  if (predicate(m.state)) return Promise.resolve(m.state)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out in ${m.state.status}; lines:\n${m.lines().map((l) => l.text).join('\n')}`)), timeoutMs)
    const onState = (s: ServerState): void => {
      if (!predicate(s)) return
      clearTimeout(timer)
      m.off('state', onState)
      resolve(s)
    }
    m.on('state', onState)
  })
}

function collect(m: ProcessManager): LogLine[] {
  const seen: LogLine[] = []
  m.on('lines', (batch) => seen.push(...batch))
  return seen
}

describe('ProcessManager with the mock', () => {
  it('starts, reaches serving, streams parsed lines, and stops with exit code 0', async () => {
    const m = manager()
    const seen = collect(m)
    const statuses: string[] = []
    m.on('state', (s) => statuses.at(-1) !== s.status && statuses.push(s.status))
    m.start({ binary: MOCK, config: await config(), version: '0.3.6.2' })
    expect(m.state.status).toBe('loading')
    expect(m.state.commandLine).toMatch(/fake-tensorfold\.mjs serve .* --port \d+ --context 89600 --reasoning-effort medium --no-update-check$/)

    const serving = await until(m, (s) => s.status === 'serving')
    expect(serving.info.serving).toMatchObject({ model: 'Qwen3.8-27B-MLX-8bit', context: 89600, drafts: true })
    expect(serving.info.drafter?.repo).toBe('z-lab/Qwen3.8-27B-DFlash2')
    await until(m, (s) => s.info.done >= 2)

    const exit = await m.stop()
    expect(exit).toMatchObject({ code: 0, signal: null, requested: true, killed: false, during: 'serving', spawnError: null })
    expect(m.state.status).toBe('stopped')
    expect(statuses).toEqual(['loading', 'serving', 'stopping', 'stopped'])

    const kinds = new Set(seen.filter((l) => l.stream === 'stdout').map((l) => l.event.kind))
    expect(kinds.has('done') && kinds.has('startup') && kinds.has('serving')).toBe(true)
    expect(seen.map((l) => l.seq)).toEqual(seen.map((_, i) => i + 1))
    expect(seen[0]).toMatchObject({ stream: 'desk' })

    const file = readFileSync(m.state.logFile as string, 'utf8')
    expect(file).toContain('[tensorfold] serving Qwen3.8-27B-MLX-8bit')
    expect(file).toMatch(/\[desk\] exited with code 0\n$/)
    expect(m.state.logFile).toMatch(/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.log$/)
  })

  it('shows a death: the exit code and the last lines, stderr included', async () => {
    const m = manager({ MOCK_TENSORFOLD_FAIL: 'crash', MOCK_TENSORFOLD_INTERVAL_MS: '0' })
    m.start({ binary: MOCK, config: await config() })
    const stopped = await until(m, (s) => s.status === 'stopped', 15_000)
    expect(stopped.lastExit).toMatchObject({ code: 1, requested: false, during: 'serving' })
    const last = stopped.lastExit?.lastLines ?? []
    expect(last.length).toBeLessThanOrEqual(50)
    expect(last.some((l) => l.stream === 'stderr' && l.text.startsWith('Traceback'))).toBe(true)
    expect(last.some((l) => l.event.kind === 'error' && l.event.what === 'stream')).toBe(true)
  })

  it('reports a failure while loading', async () => {
    const m = manager({ MOCK_TENSORFOLD_FAIL: 'startup' })
    m.start({ binary: MOCK, config: await config() })
    const stopped = await until(m, (s) => s.status === 'stopped')
    expect(stopped.lastExit).toMatchObject({ code: 1, requested: false, during: 'loading' })
  })

  it('stops a loading server at once (TensorFold has no handler yet)', async () => {
    const m = manager({ MOCK_TENSORFOLD_LOAD_MS: '10000' })
    m.start({ binary: MOCK, config: await config() })
    await new Promise((r) => setTimeout(r, 300))
    const exit = await m.stop()
    expect(exit).toMatchObject({ code: null, signal: 'SIGTERM', requested: true, during: 'loading' })
  })

  it('sends SIGKILL when SIGTERM is not enough within the grace period', async () => {
    const m = manager({ MOCK_TENSORFOLD_FAIL: 'ignore-sigterm', MOCK_TENSORFOLD_INTERVAL_MS: '0' }, 400)
    m.start({ binary: MOCK, config: await config() })
    await until(m, (s) => s.status === 'serving')
    const stopping = m.stop()
    expect(m.state.status).toBe('stopping')
    expect(m.state.killAt).toBe((m.state.stoppingSince as number) + 400)
    expect(await stopping).toMatchObject({ signal: 'SIGKILL', killed: true, requested: true })
  })

  it('reports a binary that does not start', async () => {
    const m = manager()
    m.start({ binary: '/nonexistent/tensorfold', config: await config() })
    const stopped = await until(m, (s) => s.status === 'stopped')
    expect(stopped.lastExit?.spawnError).toMatch(/ENOENT/)
  })

  it('refuses a second start, and restarts into a new session', async () => {
    const m = manager({ MOCK_TENSORFOLD_INTERVAL_MS: '0' })
    const c = await config()
    m.start({ binary: MOCK, config: c })
    expect(() => m.start({ binary: MOCK, config: c })).toThrow(/already loading/)
    await until(m, (s) => s.status === 'serving')
    const first = m.state.sessionId
    await m.restart({ binary: MOCK, config: c })
    await until(m, (s) => s.status === 'serving' && s.sessionId === first + 1)
    await m.stop()
  })
})
