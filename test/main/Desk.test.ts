import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { applyPreset, emptyConfig } from '@shared/config'
import type { HealthSample } from '@shared/health'
import { defaultSettings } from '@shared/settings'
import { Desk, normalizeConfig } from '../../src/main/Desk'
import { MemorySettings } from '../../src/main/Settings'
import { FAST_MOCK_ENV, MOCK, MOCK_MODEL, ROOT, freePort, runMock, type Run } from '../helpers'

const logDir = mkdtempSync(join(tmpdir(), 'tfdesk-desk-'))
afterAll(() => rmSync(logDir, { recursive: true, force: true }))
const desks: Desk[] = []
const runs: Run[] = []
afterEach(async () => {
  for (const d of desks.splice(0)) d.dispose()
  for (const r of runs.splice(0)) {
    r.child.kill('SIGTERM')
    await r.exited
  }
})

function desk(): Desk {
  const settings = new MemorySettings({ ...defaultSettings('/Users/test'), healthIntervalMs: 500 })
  const d = new Desk({
    settings,
    env: { ...process.env, ...FAST_MOCK_ENV },
    home: '/Users/test',
    logDir,
    mockBinary: MOCK,
    mock: true,
    appVersion: '0.0.0-test',
    platform: 'darwin'
  })
  desks.push(d)
  return d
}

describe('Desk with the mock', () => {
  it('start → events flow → health → stop', async () => {
    const d = desk()
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    const sample = new Promise<HealthSample>((resolve) => d.on('health', (s) => s.ok && resolve(s)))
    const done = new Promise<void>((resolve) => d.on('lines', (lines) => lines.some((l) => l.event.kind === 'done') && resolve()))

    expect(await d.start(config)).toEqual({ ok: true })
    expect(d.settings.lastConfig).toEqual(config)
    await done
    const s = await sample
    expect(s.ok && s.health.model).toBe('Qwen3.8-27B-MLX-8bit')
    expect(d.session().state.status).toBe('serving')
    expect(d.session().lines.length).toBeGreaterThan(10)

    expect(await d.stop()).toEqual({ ok: true })
    expect(d.session().state.lastExit?.code).toBe(0)
    expect(d.health.running).toBe(false)
  })

  it('refuses a folder without config.json and names the port holder', async () => {
    const port = await freePort()
    const holder = runMock(['serve', MOCK_MODEL, '--port', String(port)])
    runs.push(holder)
    await holder.waitFor((l) => l.includes('] serving '))

    const d = desk()
    const config = applyPreset(emptyConfig(join(ROOT, 'mock/models/lmstudio-community/Muse-Glimmer-30B-GGUF')), 'endorsed')
    config.endpoint.port = port
    const result = await d.start(config)
    expect(result.ok).toBe(false)
    const issues = result.ok ? [] : (result.issues ?? [])
    expect(issues.find((i) => i.field === 'model')?.message).toMatch(/no config\.json/)
    expect(issues.find((i) => i.field === 'endpoint.port')?.message).toBe(`a TensorFold server (Qwen3.8-27B-MLX-8bit) is already serving on port ${port}`)
    expect(d.session().state.status).toBe('stopped')
  })

  it('previews the exact command line with the binary it will run', async () => {
    const d = desk()
    const line = await d.previewCommand(applyPreset(emptyConfig('~/models/q'), 'endorsed'))
    expect(line).toBe(`${MOCK} serve /Users/test/models/q --port 8080 --context 89600 --reasoning-effort medium --no-update-check`)
  })

  it('expands ~ in the model path', () => {
    expect(normalizeConfig(emptyConfig(' ~/m '), '/Users/x').model).toBe('/Users/x/m')
  })
})
