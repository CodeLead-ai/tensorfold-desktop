import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHealth } from '@shared/health'
import { parseLine } from '../../src/main/LogParser'
import { MOCK_MODEL, ROOT, freePort, runMock } from '../helpers'

const fixture = (name: string): string => readFileSync(join(ROOT, 'test', 'fixtures', name), 'utf8')

describe('fake-tensorfold: the CLI commands', () => {
  it('prints the installed version', async () => {
    const run = runMock(['--version'])
    expect(await run.exited).toEqual({ code: 0, signal: null })
    expect(run.stdout).toEqual(['tensorfold 0.5.0'])
  })

  it('prints `serve --help` as the real 0.5.0 does, or as 0.3.6.2 does when it plays that version', async () => {
    const run = runMock(['serve', '--help'])
    expect((await run.exited).code).toBe(0)
    expect(run.stdout.join('\n') + '\n').toBe(fixture('tensorfold-serve-help-0.5.0.txt'))
    const old = runMock(['serve', '--help'], { MOCK_TENSORFOLD_VERSION: '0.3.6.2' })
    await old.exited
    expect(old.stdout.join('\n') + '\n').toBe(fixture('tensorfold-serve-help-0.3.6.2.txt'))
    const version = runMock(['--version'], { MOCK_TENSORFOLD_VERSION: '0.3.6.2' })
    await version.exited
    expect(version.stdout).toEqual(['tensorfold 0.3.6.2'])
  })

  it("refuses a flag its version's serve --help does not list, as argparse does", async () => {
    const run = runMock(['serve', MOCK_MODEL, '--min-p', '0.05'], { MOCK_TENSORFOLD_VERSION: '0.3.6.2' })
    expect((await run.exited).code).toBe(2)
    expect(run.stderr).toContain('tensorfold: error: unrecognized arguments: --min-p 0.05')
    const urls = runMock(['serve', MOCK_MODEL, '--vision-urls'])
    expect((await urls.exited).code).toBe(1)
    expect(run.stdout).toEqual([])
    expect(urls.stderr).toBe('tensorfold: --vision-urls needs --vision\n')
  })

  it('answers `update --check` as update.py does, asking no one', async () => {
    const latest = runMock(['update', '--check'])
    expect((await latest.exited).code).toBe(0)
    expect(latest.stdout).toEqual(['[tensorfold] TensorFold 0.5.0 is the latest release'])
    const newer = runMock(['update', '--check'], { MOCK_TENSORFOLD_LATEST: '0.6.0' })
    await newer.exited
    expect(newer.stdout).toEqual(['[tensorfold] TensorFold 0.6.0 is available (this is 0.5.0)'])
    const offline = runMock(['update', '--check'], { MOCK_TENSORFOLD_LATEST: 'offline' })
    expect((await offline.exited).code).toBe(1)
    expect(offline.stderr).toMatch(/^\[tensorfold\] could not reach GitHub/)
    expect((await runMock(['update']).exited).code).toBe(1)
  })

  it('prints `info` exactly as the real 0.3.6.2 and 0.5.0 do for the 27B 8-bit', async () => {
    const run = runMock(['info', MOCK_MODEL])
    expect((await run.exited).code).toBe(0)
    expect(run.stdout.join('\n') + '\n').toBe(fixture('tensorfold-info-qwen27b-8bit.txt'))
  })

  it('fails `info` as the real one does: unservable checkpoints and folders without config.json', async () => {
    const small = runMock(['info', join(ROOT, 'mock/models/lmstudio-community/Qwen3.5-0.8B-MLX-8bit')])
    expect((await small.exited).code).toBe(1)
    expect(small.stderr).toBe(fixture('tensorfold-info-unservable.stderr.txt'))
    const gguf = runMock(['info', join(ROOT, 'mock/models/lmstudio-community/Muse-Glimmer-30B-GGUF')])
    expect((await gguf.exited).code).toBe(1)
    expect(gguf.stderr).toMatch(/^tensorfold: \[Errno 2\] No such file or directory: '.*config\.json'\n$/)
  })

  it('prints the real `models` output', async () => {
    const run = runMock(['models'])
    expect((await run.exited).code).toBe(0)
    expect(run.stdout.join('\n') + '\n').toBe(fixture('tensorfold-models.txt'))
  })

  it('pulls with progress on stderr and the result line on stdout', async () => {
    const run = runMock(['pull', 'z-lab/Qwen3.8-27B-DFlash2'])
    expect((await run.exited).code).toBe(0)
    expect(run.stdout[0]).toBe('[tensorfold] downloading z-lab/Qwen3.8-27B-DFlash2 from Hugging Face')
    expect(run.stdout[1]).toMatch(/^z-lab\/Qwen3\.8-27B-DFlash2: 3\.1 GB in .* \[no model family \(a draft model\?\)\]$/)
    expect(run.stderr).toContain('\rFetching 6 files: 100%')
  })
})

describe('fake-tensorfold serve', () => {
  it('starts, answers /health, /v1/models and a chat completion, logs parseable lines, and exits 0 on SIGTERM', async () => {
    const port = await freePort()
    const run = runMock(['serve', MOCK_MODEL, '--port', String(port), '--context', '89600'], { MOCK_TENSORFOLD_INTERVAL_MS: '0' })
    const servingLine = await run.waitFor((l) => l.includes('] serving '))
    expect(parseLine(servingLine)).toMatchObject({ kind: 'serving', port, context: 89600, model: 'Qwen3.8-27B-MLX-8bit' })

    const health = parseHealth(await (await fetch(`http://127.0.0.1:${port}/health`)).json())
    expect(health?.memory.mlx_budget).toBe(44882408243)
    const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string; owned_by: string }> }
    expect(models.data[0]).toMatchObject({ id: 'Qwen3.8-27B-MLX-8bit', owned_by: 'tensorfold' })

    const reply = (await (
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Say something.' }], max_tokens: 32 })
      })
    ).json()) as { usage: { prompt_tokens: number; completion_tokens: number } }
    const doneLine = await run.waitFor((l) => l.includes('] done '))
    expect(parseLine(doneLine)).toMatchObject({ kind: 'done', prompt: reply.usage.prompt_tokens, tokens: reply.usage.completion_tokens })

    run.child.kill('SIGTERM')
    expect(await run.exited).toEqual({ code: 0, signal: null })
    expect(run.stdout.map(parseLine).filter((e) => e.kind === 'unknown')).toEqual([])
    expect(run.stderr).toBe('')
    // the lane engine saves the conversation as it stops
    expect(parseLine(run.stdout[run.stdout.length - 1] as string)).toMatchObject({ kind: 'snapshot', action: 'saved', scope: 'conversation', tokens: reply.usage.prompt_tokens + reply.usage.completion_tokens - 5 })
  })

  it("prints 0.5.0's recorded startup lines: the round's streams, and which prompts are kept", async () => {
    const run = runMock(['serve', MOCK_MODEL, '--port', String(await freePort()), '--context', '89600'], { MOCK_TENSORFOLD_INTERVAL_MS: '0' })
    await run.waitFor((l) => l.includes('] serving '))
    run.child.kill('SIGTERM')
    await run.exited
    const events = run.stdout.map(parseLine)
    expect(events.find((e) => e.kind === 'startup' && e.what === 'concurrency')).toMatchObject({ roundGb: 1.39, roundStreams: 8, fits: { streams: 4, tokens: 8192 } })
    expect(events.find((e) => e.kind === 'startup' && e.what === 'resumable')).toEqual({ kind: 'startup', what: 'resumable', tokens: 49664, budgetGib: 44.8 })
    expect(events.find((e) => e.kind === 'startup' && e.what === 'warming')).toEqual({ kind: 'startup', what: 'warming', blocks: 1 })
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
  })

  it('prints a stack dump on SIGUSR1 once armed, and ends on it before', async () => {
    const run = runMock(['serve', MOCK_MODEL, '--port', String(await freePort())], { MOCK_TENSORFOLD_INTERVAL_MS: '0' })
    await run.waitFor((l) => l.includes('] serving '))
    run.child.kill('SIGUSR1')
    await new Promise((r) => setTimeout(r, 300))
    expect(run.stderr).toMatch(/^Thread 0x[0-9a-f]+ \[tensorfold-watchdog\] \(most recent call first\):\n {2}File "/)
    expect(run.stderr).toContain('Current thread 0x')
    run.child.kill('SIGTERM')
    expect(await run.exited).toEqual({ code: 0, signal: null })

    const early = runMock(['serve', MOCK_MODEL, '--port', String(await freePort())], { MOCK_TENSORFOLD_LOAD_MS: '5000' })
    await new Promise((r) => setTimeout(r, 100))
    early.child.kill('SIGUSR1')
    expect((await early.exited).code).toBe(158)
  })

  it("replays 0.4.0+'s memory lines under pressure: streams wait, and the newest ends", async () => {
    const run = runMock(['serve', MOCK_MODEL, '--port', String(await freePort())], { MOCK_TENSORFOLD_MEMORY: 'pressure', MOCK_TENSORFOLD_TIME_SCALE: '0.0002', MOCK_TENSORFOLD_INTERVAL_MS: '5' })
    await run.waitFor((l) => l.includes('streams wait for room') && l.includes(' 0 of '), 20_000)
    run.child.kill('SIGTERM')
    await run.exited
    const notices = run.stdout.map(parseLine).filter((e) => e.kind === 'notice')
    expect(notices.map((e) => (e.kind === 'notice' ? e.what : ''))).toEqual(['memory-wait', 'memory-ended', 'memory-wait'])
    expect(notices[1]).toMatchObject({ fields: { streams: 3 } })
  })

  it('replays the K3 requests on a timer', async () => {
    const port = await freePort()
    const run = runMock(['serve', MOCK_MODEL, '--port', String(port)], { MOCK_TENSORFOLD_TIME_SCALE: '0.0002', MOCK_TENSORFOLD_INTERVAL_MS: '5' })
    await run.waitFor((l) => l.includes('] done '))
    await run.waitFor((l) => l.includes('] start failed '), 20_000)
    run.child.kill('SIGTERM')
    await run.exited
    const kinds = new Set(run.stdout.map((l) => parseLine(l).kind))
    expect([...kinds].sort()).toEqual(['access', 'done', 'refused', 'serving', 'snapshot', 'startup'])
  })

  it('refuses a request whose reply cannot be reserved, logging `start failed`', async () => {
    const port = await freePort()
    const run = runMock(['serve', MOCK_MODEL, '--port', String(port), '--context', '89600'], { MOCK_TENSORFOLD_INTERVAL_MS: '0' })
    await run.waitFor((l) => l.includes('] serving '))
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4000) }], max_tokens: 88000 })
    })
    expect(res.status).toBe(400)
    const refusal = parseLine(await run.waitFor((l) => l.includes('] start failed ')))
    expect(refusal).toMatchObject({ kind: 'refused', errorType: 'RequestError', replyTokens: 88000 })
    run.child.kill('SIGTERM')
    await run.exited
  })

  it('dies at once on SIGTERM while loading, like TensorFold before its handler is installed', async () => {
    const run = runMock(['serve', MOCK_MODEL, '--port', String(await freePort())], { MOCK_TENSORFOLD_LOAD_MS: '5000' })
    await run.waitFor((l) => l.includes('] loading '))
    run.child.kill('SIGTERM')
    expect(await run.exited).toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('fails at startup with a traceback on stderr when asked to', async () => {
    const run = runMock(['serve', MOCK_MODEL, '--port', String(await freePort())], { MOCK_TENSORFOLD_FAIL: 'startup' })
    expect((await run.exited).code).toBe(1)
    expect(run.stderr).toMatch(/^Traceback \(most recent call last\):/)
    expect(run.stderr).toContain('MemoryError')
  })

  it('reports a port in use as TensorFold does, after loading', async () => {
    const blocker = createServer().listen(0, '127.0.0.1')
    await new Promise((r) => blocker.once('listening', r))
    const address = blocker.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const run = runMock(['serve', MOCK_MODEL, '--port', String(port)])
    expect((await run.exited).code).toBe(1)
    expect(run.stderr).toContain('OSError: [Errno 48] Address already in use')
    blocker.close()
  })

  it('refuses a folder without config.json before loading anything', async () => {
    const run = runMock(['serve', join(ROOT, 'mock/models/lmstudio-community/Muse-Glimmer-30B-GGUF')])
    expect((await run.exited).code).toBe(1)
    expect(run.stdout).toEqual([])
    expect(run.stderr).toMatch(/^tensorfold: \[Errno 2\] No such file or directory/)
  })
})
