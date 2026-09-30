import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ServerState } from '@shared/api'
import { familyFor, infoError, parseInfo, parseModels, runsHere } from '@shared/checkpoints'
import { applyPreset, emptyConfig, type ServeConfig } from '@shared/config'
import type { DoneEvent } from '@shared/events'
import { parseLmsPs } from '@shared/lmstudio'
import { matchDone, takeSseData } from '@shared/probe'
import { parseProgress, parsePullResult } from '@shared/pull'
import { applyEvent, emptySessionInfo } from '@shared/session'
import { buildSnapshot, configFromSnapshot, reproduceCommandLine, runnerLines } from '@shared/snapshot'
import { parseLine } from '../../src/main/LogParser'

const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')

describe('tensorfold info and models', () => {
  it('reads the real info output of the 27B 8-bit', () => {
    expect(parseInfo(fixture('tensorfold-info-qwen27b-8bit.txt'))).toMatchObject({
      modelType: 'qwen3_5',
      family: 'Qwen3.8 dense',
      engine: 'MLX lane engine, CUDA engine',
      kernels: 'qwen/dense/v1',
      layers: 64,
      hiddenSize: 5120,
      vocab: 248320,
      maxPositionEmbeddings: 262144,
      quantization: 'MLX 8-bit, groups of 64',
      cudaFormats: 'affine 2/3/4/5/6/8-bit, groups 32/64/128',
      runsOn: 'Apple Silicon (MLX), NVIDIA GPUs (CUDA)',
      sampling: { temperature: 1, top_k: 20, top_p: 0.95 }
    })
  })

  it('knows a checkpoint whose family runs only on CUDA is not servable on a Mac (info exits 0 for it)', () => {
    const cudaOnly = parseInfo(fixture('tensorfold-info-cuda-only.txt'))
    expect(cudaOnly).toMatchObject({ modelType: 'qwen3_5_moe', family: 'Qwen3.6 MoE', runsOn: 'NVIDIA GPUs (CUDA)' })
    expect(runsHere(cudaOnly, 'darwin')).toBe(false)
    expect(runsHere(cudaOnly, 'linux')).toBe(true)
    expect(runsHere(parseInfo(fixture('tensorfold-info-qwen27b-8bit.txt')), 'darwin')).toBe(true)
  })

  it('takes the reason from a failed info', () => {
    expect(infoError(fixture('tensorfold-info-unservable.stderr.txt'))).toMatch(/^Qwen3\.8 dense cannot run this checkpoint: the tied embedding head/)
    expect(infoError(fixture('tensorfold-info-gguf.stderr.txt'))).toMatch(/^\[Errno 2\] No such file or directory/)
  })

  it('reads the families of `tensorfold models` (0.5.0, and 0.3.6.2)', () => {
    expect(parseModels(fixture('tensorfold-models-0.3.6.2.txt')).map((f) => f.modelType)).toEqual(['gemma4', 'gemma4_text', 'glm5_next', 'nemotron_h', 'qwen3_5', 'qwen3_5_moe', 'qwen4_exp'])
    const families = parseModels(fixture('tensorfold-models.txt'))
    expect(families.map((f) => f.modelType)).toEqual(['deepseek_v4', 'gemma4', 'gemma4_text', 'glm5_next', 'nemotron_h', 'prism_hadamard_qwen35', 'qwen3_5', 'qwen3_5_moe', 'qwen4_exp'])
    expect(families.find((f) => f.modelType === 'qwen3_5')).toEqual({
      title: 'Qwen3.8 dense',
      modelType: 'qwen3_5',
      engines: ['MLX lane engine', 'CUDA engine'],
      kernels: 'qwen/dense/v1',
      models: ['Vontra/Qwen3.8-27B-MLX-4bit', 'turboderp/Qwen3.8-27B-exl3', 'nvidia/Qwen3.8-27B-NVFP4'],
      drafters: ['z-lab/Qwen3.8-27B-DFlash2']
    })
    expect(families.find((f) => f.modelType === 'prism_hadamard_qwen35')).toMatchObject({ title: 'Ternary Bonsai 2', drafters: ['z-lab/Qwen3.8-27B-DFlash2'] })
    expect(familyFor(families, 'qwen3_5_moe', 'darwin')).toBeNull()
    expect(familyFor(families, 'qwen3_5_moe', 'linux')?.title).toBe('Qwen3.6 MoE')
  })
})

describe('pull output', () => {
  it('reads tqdm bars and the result line', () => {
    expect(parseProgress('Fetching 6 files:  50%|█████     | 3/6 [00:01<00:01,  2.50it/s]')).toEqual({ label: 'Fetching 6 files', percent: 50, done: '3', total: '6' })
    expect(parseProgress('model-00001-of-00006.safetensors:  13%|█▎        | 700M/5.37G [00:12<01:20, 58.0MB/s]')).toMatchObject({ percent: 13, done: '700M', total: '5.37G' })
    expect(parseProgress('[tensorfold] downloading x from Hugging Face')).toBeNull()
    expect(parsePullResult('z-lab/Qwen3.8-27B-DFlash2: 3.1 GB in /hub/models--z-lab--Qwen3.8-27B-DFlash2/snapshots/abc [no model family (a draft model?)]')).toEqual({
      repo: 'z-lab/Qwen3.8-27B-DFlash2',
      gb: 3.1,
      path: '/hub/models--z-lab--Qwen3.8-27B-DFlash2/snapshots/abc',
      what: 'no model family (a draft model?)'
    })
  })
})

describe('lms ps --json', () => {
  it('reads what LM Studio has loaded (a real answer from this Mac)', () => {
    expect(parseLmsPs(fixture('lms-ps.json'))).toEqual([
      { identifier: 'google/gemma-4-e4b', modelKey: 'google/gemma-4-e4b', displayName: 'Gemma 4 E4B', sizeBytes: 6861935454, status: 'generating', contextLength: 131072, architecture: 'gemma4' }
    ])
    expect(parseLmsPs('[]')).toEqual([])
    expect(() => parseLmsPs('{}')).toThrow()
  })
})

describe('probe helpers', () => {
  it('splits server-sent events and keeps a partial line', () => {
    expect(takeSseData('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b"')).toEqual({ data: ['{"a":1}', '[DONE]'], rest: 'data: {"b"' })
  })

  it('matches a done line by its token counts, after the request started', () => {
    const done = (prompt: number, tokens: number): DoneEvent =>
      parseLine(`[tensorfold] done req-1 prompt=${prompt} cached=0 thinking=True effort=low tokens=${tokens} sha=a finish=stop tok/s=50.0 ttft=0.10s prefill=0.10s rounds=1 accepted=0/0 checkpoints=off`) as DoneEvent
    const candidates = [
      { at: 900, event: done(10, 5) },
      { at: 1100, event: done(99, 5) },
      { at: 1200, event: done(10, 5) }
    ]
    expect(matchDone(candidates, 1000, 10, 5)).toBe(candidates[2]?.event)
    expect(matchDone(candidates, 1000, 11, 5)).toBeNull()
  })
})

function servingState(config: ServeConfig): ServerState {
  const lines = fixture('serve-log-2026-09-29.txt').split('\n').filter(Boolean)
  return {
    status: 'serving',
    sessionId: 1,
    pid: 1,
    binary: '/Users/peter/Projects/codelead-bench/tensorfold-venv/bin/tensorfold',
    version: '0.3.6.2',
    config,
    argv: [],
    commandLine: '',
    startedAt: Date.UTC(2026, 8, 29, 12),
    servingAt: Date.UTC(2026, 8, 29, 12, 0, 31),
    stoppingSince: null,
    killAt: null,
    logFile: null,
    info: lines.map(parseLine).reduce(applyEvent, emptySessionInfo()),
    lastExit: null
  }
}

describe('serving snapshot (SPEC §3.10, §6.6)', () => {
  const model = '/Users/peter/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit'

  it('reproduces the command line of the endorsed preset and of every flag', async () => {
    const { buildServeArgv, buildServeEnv, formatCommandLine } = await import('@shared/config')
    const configs: ServeConfig[] = [applyPreset(emptyConfig(model), 'endorsed')]
    const every = applyPreset(emptyConfig(model), 'serial')
    every.endpoint = { host: '0.0.0.0', port: 9000, name: 'q', alias: ['a', 'b'], vision: true, visionUrls: true }
    every.generation = { ...every.generation, thinking: false, topK: 20, temperature: 0.6, minP: 0.05 }
    every.drafting = { ...every.drafting, parallel: 'auto', decodeShare: 0, ssdExperts: 12.5, snapshotDir: '/tmp/s' }
    every.nvidia = { tp: 2, kvDtype: 'int8' }
    every.env = { memoryLimitGb: 51.8 }
    configs.push(every)
    // a newer TensorFold's flags, unknown to the app's table
    configs.push({ ...applyPreset(emptyConfig(model), 'endorsed'), extra: { '--future-share': '0.5', '--turbo': true } })
    for (const config of configs) {
      const state = servingState(config)
      state.argv = buildServeArgv(config)
      state.commandLine = formatCommandLine(state.binary as string, state.argv, buildServeEnv(config))
      const snapshot = JSON.parse(JSON.stringify(buildSnapshot({ state, health: null, exportedAt: 0, appVersion: '0.1.0', machine: { chip: 'M', memoryGiB: 64, os: 'darwin' }, configSha256: null })))
      expect(reproduceCommandLine(snapshot)).toBe(state.commandLine)
      expect(configFromSnapshot(snapshot)).toEqual(config)
    }
  })

  it('records the checkpoint, the drafter, the budget and the runner lines', () => {
    const state = servingState(applyPreset(emptyConfig(model), 'endorsed'))
    const s = buildSnapshot({ state, health: null, exportedAt: 0, appVersion: '0.1.0', machine: { chip: 'M', memoryGiB: 64, os: 'darwin' }, configSha256: 'abc' })
    expect(s.checkpoint).toEqual({ path: model, repo: 'lmstudio-community/Qwen3.8-27B-MLX-8bit', sha: null, configSha256: 'abc' })
    expect(s.drafter).toMatchObject({ name: 'z-lab/Qwen3.8-27B-DFlash2', sha: '50307d4c4cde6860d4eee73e2547cd786fe8e8a4', block: 8, bits: 4 })
    expect(s.memory).toMatchObject({ budgetGib: 44.8, mlxGib: 41.8, ceilingGib: 51.8 })
    expect(s.flags['--port']).toEqual({ group: 'endpoint', value: 8080, passed: true, default: '8080' })
    expect(s.flags['--host']).toEqual({ group: 'endpoint', value: null, passed: false, default: '127.0.0.1' })
    expect(runnerLines(state)).toBe('CODELEAD_BASE_URL=http://127.0.0.1:8080/v1\nCODELEAD_MODEL=Qwen3.8-27B-MLX-8bit')
  })
})
