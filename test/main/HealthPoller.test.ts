import { afterEach, describe, expect, it } from 'vitest'
import type { HealthSample } from '@shared/health'
import { HealthPoller, healthBase } from '../../src/main/HealthPoller'
import { MOCK_MODEL, freePort, runMock, type Run } from '../helpers'

let run: Run | null = null
const pollers: HealthPoller[] = []
afterEach(async () => {
  for (const p of pollers.splice(0)) p.stop()
  if (run) {
    run.child.kill('SIGTERM')
    await run.exited
    run = null
  }
})

function samples(p: HealthPoller, n: number, timeoutMs = 10_000): Promise<HealthSample[]> {
  const got: HealthSample[] = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`only ${got.length} samples`)), timeoutMs)
    p.on('sample', (s) => {
      got.push(s)
      if (got.length === n) {
        clearTimeout(timer)
        resolve(got)
      }
    })
  })
}

describe('HealthPoller', () => {
  it('reads /health on its interval', async () => {
    const port = await freePort()
    run = runMock(['serve', MOCK_MODEL, '--port', String(port)])
    await run.waitFor((l) => l.includes('] serving '))
    const p = new HealthPoller({ intervalMs: 100 })
    pollers.push(p)
    p.start(healthBase('127.0.0.1', port))
    const got = await samples(p, 3)
    for (const s of got) expect(s.ok).toBe(true)
    const first = got[0]
    expect(first?.ok && first.health.memory.mlx_budget).toBe(44882408243)
    expect(got[2]!.at - got[0]!.at).toBeGreaterThanOrEqual(150)
  })

  it('backs off while the server does not answer', async () => {
    const port = await freePort()
    const p = new HealthPoller({ intervalMs: 50, maxIntervalMs: 400, timeoutMs: 200 })
    pollers.push(p)
    p.start(healthBase('127.0.0.1', port))
    const got = await samples(p, 4)
    expect(got.map((s) => (s.ok ? 0 : s.failures))).toEqual([1, 2, 3, 4])
    expect(got[3]!.at - got[2]!.at).toBeGreaterThanOrEqual(350)
  })

  it('polls loopback for a wildcard host', () => {
    expect(healthBase('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080')
    expect(healthBase('::1', 8080)).toBe('http://[::1]:8080')
  })
})
