import { describe, expect, it } from 'vitest'
import { defaultSettings, sanitizeSettings } from '@shared/settings'

const defaults = defaultSettings('/Users/test')

describe('settings', () => {
  it('defaults to the endorsed form, LM Studio and the Hugging Face cache, and no restore command', () => {
    expect(defaults.checkpointRoots).toEqual(['/Users/test/.lmstudio/models', '/Users/test/.cache/huggingface/hub'])
    expect(defaults.unloadCommand).toBe('lms unload --all')
    expect(defaults.restoreCommand).toBe('')
    expect(defaults.lastConfig.endpoint.port).toBe(8080)
    expect(defaults.stopGraceSeconds).toBe(30)
  })

  it('repairs whatever is stored', () => {
    const s = sanitizeSettings(
      { binaryPath: 3, checkpointRoots: ['/a', '', 5, ' /b '], stopGraceSeconds: 10_000, healthIntervalMs: 'fast', theme: 'neon', lastConfig: { model: 1 }, probe: { maxTokens: -5, reasoningEffort: null } },
      defaults
    )
    expect(s.binaryPath).toBe('')
    expect(s.checkpointRoots).toEqual(['/a', '/b'])
    expect(s.stopGraceSeconds).toBe(600)
    expect(s.healthIntervalMs).toBe(2000)
    expect(s.theme).toBe('dark')
    expect(s.lastConfig).toEqual(defaults.lastConfig)
    expect(s.probe.maxTokens).toBe(1)
    expect(s.probe.reasoningEffort).toBeNull()
  })

  it('keeps what is valid', () => {
    const custom = { ...defaults, binaryPath: '/venv/bin/tensorfold', theme: 'light' as const, restoreCommand: 'reload.sh' }
    expect(sanitizeSettings(custom, defaults)).toEqual(custom)
  })
})
