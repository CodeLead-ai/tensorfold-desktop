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

  it('needs a snapshot directory for spilling', () => {
    expect(fields({ ...emptyConfig(MODEL), drafting: { spillGib: 8, snapshotDir: 'none' } })).toEqual(['drafting.spillGib'])
  })

  it('warns, without blocking, about NVIDIA flags on a Mac and a network-wide host', () => {
    const issues = validateConfig({ ...emptyConfig(MODEL), endpoint: { host: '0.0.0.0' }, nvidia: { tp: 2 } })
    expect(hasErrors(issues)).toBe(false)
    expect(issues.map((i) => i.field).sort()).toEqual(['endpoint.host', 'nvidia.tp'])
    expect(validateConfig({ ...emptyConfig(MODEL), nvidia: { tp: 2 } }, 'linux')).toEqual([])
  })
})
