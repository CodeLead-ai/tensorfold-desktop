import { describe, expect, it } from 'vitest'
import { applyPreset, emptyConfig, type ServeConfig } from '@shared/config'
import { hasErrors, validateConfig } from '@shared/validate'

const MODEL = '/Users/peter/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit'
const fields = (config: ServeConfig): string[] => validateConfig(config).filter((i) => i.severity === 'error').map((i) => i.field)

describe('validateConfig', () => {
  it('accepts the endorsed preset', () => {
    expect(validateConfig(applyPreset(emptyConfig(MODEL), 'endorsed'))).toEqual([])
  })

  it('wants a model: a folder path or an owner/name repo id', () => {
    expect(fields(emptyConfig(''))).toEqual(['model'])
    expect(fields(emptyConfig('just-a-name'))).toEqual(['model'])
    expect(fields(emptyConfig('z-lab/Qwen3.8-27B-DFlash2'))).toEqual([])
    expect(validateConfig(emptyConfig('z-lab/Qwen3.8-27B-DFlash2'))[0]).toMatchObject({ severity: 'warning' })
  })

  it('wants the context to be a positive integer (SPEC §3.1)', () => {
    for (const context of [0, -1, 1.5, Number.NaN]) {
      expect(fields({ ...emptyConfig(MODEL), generation: { context } })).toEqual(['generation.context'])
    }
  })

  it('checks ranges', () => {
    const bad: ServeConfig = {
      ...emptyConfig(MODEL),
      endpoint: { port: 70000, host: 'a b' },
      generation: { topP: 1.5, topK: -1, temperature: -0.1 },
      drafting: { parallel: 0, checkpointSlots: 0, mtpConfidence: 2 }
    }
    expect(fields(bad).sort()).toEqual(
      ['drafting.checkpointSlots', 'drafting.mtpConfidence', 'drafting.parallel', 'endpoint.host', 'endpoint.port', 'generation.temperature', 'generation.topK', 'generation.topP'].sort()
    )
  })

  it("checks 0.5.0's flags: min-p is a probability, decode-share is 0 or more, --vision-urls needs --vision", () => {
    expect(fields({ ...emptyConfig(MODEL), generation: { minP: 1.5 } })).toEqual(['generation.minP'])
    expect(fields({ ...emptyConfig(MODEL), generation: { minP: 0 } })).toEqual([])
    expect(fields({ ...emptyConfig(MODEL), drafting: { decodeShare: -0.1 } })).toEqual(['drafting.decodeShare'])
    expect(fields({ ...emptyConfig(MODEL), drafting: { decodeShare: 0 } })).toEqual([])
    expect(fields({ ...emptyConfig(MODEL), endpoint: { visionUrls: true } })).toEqual(['endpoint.visionUrls'])
    expect(fields({ ...emptyConfig(MODEL), endpoint: { vision: true, visionUrls: true } })).toEqual([])
  })

  it("refuses a flag the installed binary's serve --help does not list, only when it is passed", () => {
    const old = { version: '0.3.6.2', switches: new Set(['--port', '--context', '--vision-urls']) }
    const config: ServeConfig = { ...emptyConfig(MODEL), generation: { context: 4096, minP: 0.1 }, endpoint: { vision: false }, extra: { '--turbo': true } }
    expect(validateConfig(config, 'darwin', old).filter((i) => i.severity === 'error')).toEqual([
      { field: 'generation.minP', message: 'tensorfold 0.3.6.2 has no --min-p (it came in 0.5.0)', severity: 'error' },
      { field: 'extra.--turbo', message: 'tensorfold 0.3.6.2 has no --turbo', severity: 'error' }
    ])
    expect(validateConfig(config).filter((i) => i.severity === 'error')).toEqual([])
  })

  it('needs a snapshot directory for spilling', () => {
    expect(fields({ ...emptyConfig(MODEL), drafting: { spillGib: 8, snapshotDir: 'none' } })).toEqual(['drafting.spillGib'])
  })

  it('warns, without blocking, about NVIDIA flags on a Mac and a network address typed as the host', () => {
    const issues = validateConfig({ ...emptyConfig(MODEL), endpoint: { host: '10.0.0.157' }, nvidia: { tp: 2 } })
    expect(hasErrors(issues)).toBe(false)
    expect(issues.map((i) => i.field).sort()).toEqual(['endpoint.host', 'nvidia.tp'])
    expect(validateConfig({ ...emptyConfig(MODEL), nvidia: { tp: 2 } }, 'linux')).toEqual([])
  })

  it('leaves the remote-connections switch (--host 0.0.0.0) to its own confirmation, and this Mac alone unwarned', () => {
    for (const host of ['0.0.0.0', '127.0.0.1', 'localhost', '::1']) {
      expect(validateConfig({ ...emptyConfig(MODEL), endpoint: { host } }), host).toEqual([])
    }
  })
})
