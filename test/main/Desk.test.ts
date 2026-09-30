import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { FLAGS, applyPreset, emptyConfig } from '@shared/config'
import type { HealthSample } from '@shared/health'
import { defaultSettings } from '@shared/settings'
import { reproduceCommandLine } from '@shared/snapshot'
import { Desk, normalizeConfig } from '../../src/main/Desk'
import { LMSTUDIO_PROCESS } from '../../src/main/LmStudio'
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

function desk(settingsPatch: Partial<ReturnType<typeof defaultSettings>> = {}, env: Record<string, string> = {}, lmStudioRunning = true): Desk {
  const settings = new MemorySettings({ ...defaultSettings('/Users/test'), healthIntervalMs: 500, ...settingsPatch })
  const d = new Desk({
    settings,
    env: { ...process.env, ...FAST_MOCK_ENV, ...env },
    home: '/Users/test',
    logDir,
    snapshotDir: join(logDir, 'snapshots'),
    infoCacheFile: join(logDir, 'cache', 'info.json'),
    lmStudioRunning: async () => lmStudioRunning,
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

describe('P1 against the mock', () => {
  const mockRoots = [join(ROOT, 'mock/models'), join(ROOT, 'mock/hf-cache/hub')]
  const fakeLms = join(ROOT, 'mock/fake-lms.mjs')
  // Inside logDir, which afterAll removes.
  const lmsState = (): Record<string, string> => ({ FAKE_LMS_STATE: join(mkdtempSync(join(logDir, 'lms-')), 'state.json') })

  it('scans the checkpoint folders and asks tensorfold info about each', async () => {
    const d = desk({ checkpointRoots: mockRoots })
    const scan = await d.listCheckpoints(true)
    expect(scan.error).toBeNull()
    expect(scan.families.map((f) => f.modelType)).toContain('qwen3_5')
    const byName = (name: string) => scan.checkpoints.find((c) => c.path.endsWith(name))
    expect(byName('Qwen3.8-27B-MLX-8bit')).toMatchObject({
      servable: true,
      source: 'folder',
      repo: 'lmstudio-community/Qwen3.8-27B-MLX-8bit',
      testedFamily: true,
      testedCheckpoint: false,
      drafter: { repo: 'z-lab/Qwen3.8-27B-DFlash2', pulled: true },
      info: { family: 'Qwen3.8 dense', modelType: 'qwen3_5', maxPositionEmbeddings: 262144, quantization: 'MLX 8-bit, groups of 64', layers: 64 }
    })
    expect(byName('Qwen3.5-0.8B-MLX-8bit')).toMatchObject({ servable: false, reason: expect.stringMatching(/^Qwen3\.8 dense cannot run this checkpoint/) })
    expect(byName('Muse-Glimmer-30B-GGUF')).toMatchObject({ servable: false, reason: expect.stringMatching(/^GGUF/) })
    expect(scan.checkpoints.find((c) => c.repo === 'z-lab/Qwen3.8-27B-DFlash2')).toMatchObject({ isDrafter: true, source: 'huggingface', sha: '50307d4c4cde6860d4eee73e2547cd786fe8e8a4', servable: false })
    expect(scan.checkpoints.slice(0, 2).every((c) => c.servable)).toBe(true)
  })

  it('pulls with progress and reads the result line', async () => {
    const d = desk()
    const finished = new Promise<import('@shared/pull').PullState>((resolve) => d.on('pull', (s) => s.status !== 'running' && resolve(s)))
    expect(await d.pull('z-lab/Qwen3.8-27B-DFlash2')).toEqual({ ok: true })
    const state = await finished
    expect(state).toMatchObject({ status: 'done', exitCode: 0, progress: { percent: 100, done: '6', total: '6' }, result: { repo: 'z-lab/Qwen3.8-27B-DFlash2', gb: 3.1 } })
    expect(await d.pull('not a repo')).toMatchObject({ ok: false })
  })

  it('unloads LM Studio, serves, then stops and restores it', async () => {
    const env = lmsState()
    const d = desk({ lmsPath: fakeLms, restoreCommand: 'lms load google/gemma-4-e4b' }, env)
    expect((await d.lmStudioStatus()).models.map((m) => m.identifier)).toEqual(['google/gemma-4-e4b'])
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    const served = await d.unloadAndServe(config)
    expect(served).toMatchObject({ ok: true, error: null })
    expect(served.steps[0]).toMatchObject({ ok: true, command: 'lms unload --all', output: expect.stringContaining('Unloaded "google/gemma-4-e4b"') })
    expect((await d.lmStudioStatus()).models).toEqual([])
    expect(d.session().state.status).not.toBe('stopped')

    const restored = await d.stopAndRestore()
    expect(restored).toMatchObject({ ok: true })
    expect(d.session().state.status).toBe('stopped')
    expect((await d.lmStudioStatus()).models.map((m) => m.identifier)).toEqual(['google/gemma-4-e4b'])
  })

  it('says clearly when lms is not there, and starts nothing', async () => {
    const d = desk({ lmsPath: '/nonexistent/lms' })
    const status = await d.lmStudioStatus()
    expect(status).toMatchObject({ available: false, models: [] })
    expect(status.error).toMatch(/LM Studio's lms was not found/)
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    const result = await d.unloadAndServe(config)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/)
    expect(d.session().state.status).toBe('stopped')
    expect(await d.stopAndRestore()).toMatchObject({ ok: false, error: expect.stringMatching(/no restore command/) })
  })

  it('probes: measures a streamed reply and finds its done line; reports a refusal', async () => {
    const d = desk({}, { MOCK_TENSORFOLD_INTERVAL_MS: '0', MOCK_TENSORFOLD_TOKENS_PER_S: '400' })
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    await d.start(config)
    await new Promise<void>((resolve) => d.on('state', (s) => s.status === 'serving' && resolve()))
    const streamed = await d.probe({ prompt: 'Say something short.', maxTokens: 24, reasoningEffort: 'low', stream: true, label: 'solo' })
    expect(streamed).toMatchObject({ ok: true, label: 'solo', completionTokens: 24, finish: 'length' })
    expect(streamed.ttftS).toBeGreaterThan(0)
    expect(streamed.tokPerS).toBeGreaterThan(0)
    expect(streamed.server).toMatchObject({ prompt: streamed.promptTokens, tokens: 24, effort: 'low' })
    const whole = await d.probe({ prompt: 'Again.', maxTokens: 16, reasoningEffort: null, stream: false })
    expect(whole).toMatchObject({ ok: true, ttftS: null, completionTokens: 16 })
    expect(whole.server?.tokens).toBe(16)
    const refused = await d.probe({ prompt: 'x'.repeat(4000), maxTokens: 88000, reasoningEffort: null, stream: false })
    expect(refused).toMatchObject({ ok: false, status: 400 })
    expect(refused.error).toMatch(/needs about .* GiB of the 41\.8 GiB MLX may use/)

    const exported = d.exportSnapshot()
    if (!exported.ok) throw new Error(exported.error)
    const snapshot = JSON.parse(readFileSync(exported.path, 'utf8')) as import('@shared/snapshot').ServingSnapshot
    expect(reproduceCommandLine(snapshot)).toBe(snapshot.commandLine)
    expect(snapshot.commandLine).toBe(d.session().state.commandLine)
    expect(Object.keys(snapshot.flags)).toHaveLength(FLAGS.length)
    expect(snapshot).toMatchObject({
      tensorfold: { version: '0.5.0' },
      extraFlags: {},
      checkpoint: { path: MOCK_MODEL, configSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      drafter: { repo: 'z-lab/Qwen3.8-27B-DFlash2', block: 8, bits: 4 },
      serving: { model: 'Qwen3.8-27B-MLX-8bit', context: 89600, drafts: true, lanes: 8, keptPromptTokens: 49664 },
      runner: { CODELEAD_BASE_URL: `http://127.0.0.1:${config.endpoint.port}/v1`, CODELEAD_MODEL: 'Qwen3.8-27B-MLX-8bit' }
    })
    expect(d.runnerLines()).toBe(`CODELEAD_BASE_URL=http://127.0.0.1:${config.endpoint.port}/v1\nCODELEAD_MODEL=Qwen3.8-27B-MLX-8bit`)
    await d.stop()
  })
})

describe('the installed version', () => {
  it("checks the form against the binary's serve --help: a flag its version lacks is an error", async () => {
    const config = { ...applyPreset(emptyConfig(MOCK_MODEL), 'endorsed'), generation: { context: 89600, minP: 0.05 } }
    config.endpoint.port = await freePort()
    const newer = await desk().validate(config)
    expect(newer.filter((i) => i.severity === 'error')).toEqual([])
    const old = desk({}, { MOCK_TENSORFOLD_VERSION: '0.3.6.2' })
    expect((await old.validate(config)).filter((i) => i.severity === 'error')).toEqual([
      { field: 'generation.minP', message: 'tensorfold 0.3.6.2 has no --min-p (it came in 0.5.0)', severity: 'error' }
    ])
    expect(await old.start(config)).toMatchObject({ ok: false, error: 'the configuration has errors' })
    const extra = await desk().validate({ ...config, generation: { context: 89600 }, extra: { '--future-share': '0.5' } })
    expect(extra).toContainEqual({ field: 'extra.--future-share', message: 'tensorfold 0.5.0 has no --future-share', severity: 'error' })
  })

  it('refuses --vision for a checkpoint without a vision config, as TensorFold would', async () => {
    const config = { ...emptyConfig(MOCK_MODEL), endpoint: { port: await freePort(), vision: true } }
    expect(await desk().validate(config)).toContainEqual({ field: 'endpoint.vision', message: 'this checkpoint has no vision_config: --vision needs a vision-language checkpoint', severity: 'error' })
    const dir = mkdtempSync(join(tmpdir(), 'tfdesk-vl-'))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model_type: 'qwen3_5', vision_config: { depth: 27 } }))
    expect((await desk().validate({ ...config, model: dir })).filter((i) => i.field === 'endpoint.vision')).toEqual([])
    expect(await desk().validate({ ...config, model: dir, endpoint: { visionUrls: true } })).toContainEqual({ field: 'endpoint.visionUrls', message: 'needs --vision', severity: 'error' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('checks for a newer release with `update --check`, installing nothing', async () => {
    expect(await desk().checkUpdate()).toMatchObject({ ok: true, current: '0.5.0', latest: '0.5.0', newer: false, command: `${MOCK} update` })
    expect(await desk({}, { MOCK_TENSORFOLD_LATEST: '0.6.0' }).checkUpdate()).toMatchObject({
      ok: true,
      current: '0.5.0',
      latest: '0.6.0',
      newer: true,
      notesUrl: 'https://github.com/ashhart/TensorFold/releases/tag/v0.6.0'
    })
    const offline = await desk({}, { MOCK_TENSORFOLD_LATEST: 'offline' }).checkUpdate()
    expect(offline).toMatchObject({ ok: false, newer: false })
    expect(offline.error).toMatch(/^could not reach GitHub/)
  })

  it('dumps the stacks with SIGUSR1 only once TensorFold has armed it, and they arrive on stderr', async () => {
    const d = desk({}, { MOCK_TENSORFOLD_INTERVAL_MS: '0', MOCK_TENSORFOLD_LOAD_MS: '1500' })
    expect(d.dumpStacks()).toEqual({ ok: false, error: 'the server is not running' })
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    await d.start(config)
    expect(d.dumpStacks()).toMatchObject({ ok: false, error: expect.stringMatching(/^not yet/) })
    await new Promise<void>((resolve) => d.on('state', (s) => s.status === 'serving' && resolve()))
    const dumped = new Promise<void>((resolve) => d.on('lines', (lines) => lines.some((l) => l.stream === 'stderr' && l.text.startsWith('Current thread 0x')) && resolve()))
    expect(d.dumpStacks()).toEqual({ ok: true })
    await dumped
    expect(d.session().state.status).toBe('serving')
    expect(d.session().lines.some((l) => l.stream === 'desk' && l.text.startsWith('SIGUSR1 sent'))).toBe(true)
    await d.stop()
  })
})

describe('LM Studio not running', () => {
  it('reports it without asking lms (which could start LM Studio), and serves without unloading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tfdesk-nolms-'))
    const marker = join(dir, 'lms-was-run')
    const lms = join(dir, 'lms')
    writeFileSync(lms, `#!/bin/sh\ntouch '${marker}'\necho '[]'\n`)
    chmodSync(lms, 0o755)
    const d = desk({ lmsPath: lms }, { MOCK_TENSORFOLD_INTERVAL_MS: '0' }, false)
    expect(await d.lmStudioStatus()).toMatchObject({ running: false, available: false, models: [], error: null })
    const config = applyPreset(emptyConfig(MOCK_MODEL), 'endorsed')
    config.endpoint.port = await freePort()
    expect(await d.unloadAndServe(config)).toEqual({ ok: true, error: null, steps: [] })
    expect(existsSync(marker)).toBe(false)
    await d.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('recognizes LM Studio in the process list, and not its helpers', () => {
    expect(LMSTUDIO_PROCESS.test('/Applications/LM Studio.app/Contents/MacOS/LM Studio')).toBe(true)
    expect(LMSTUDIO_PROCESS.test('/Users/p/.lmstudio/llmster/0.1/llmster --port 1234')).toBe(true)
    expect(LMSTUDIO_PROCESS.test('/Applications/LM Studio.app/Contents/Frameworks/LM Studio Helper (GPU).app/Contents/MacOS/LM Studio Helper (GPU) --type=gpu-process')).toBe(false)
    expect(LMSTUDIO_PROCESS.test('/usr/bin/vim notes-about-LM-Studio.txt')).toBe(false)
  })
})
