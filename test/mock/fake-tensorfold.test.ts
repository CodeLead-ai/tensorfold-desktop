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
    expect(run.stdout).toEqual(['tensorfold 0.3.6.2'])
  })

  it('prints `info` exactly as the real 0.3.6.2 does for the 27B 8-bit', async () => {
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
