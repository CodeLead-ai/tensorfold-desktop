import { describe, expect, it } from 'vitest'
import { parseEnvDump, withFallbackPath } from '../../src/main/shellEnv'

describe('login shell environment', () => {
  it('reads the env dump between the markers, ignoring shell banners', () => {
    const dump = 'Welcome!\n__TFDESK_ENV__PATH=/opt/homebrew/bin:/usr/bin\nHF_HOME=/data/hf\nODD\n__TFDESK_ENV__'
    expect(parseEnvDump(dump)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HF_HOME: '/data/hf' })
    expect(parseEnvDump('no markers')).toEqual({})
  })

  it('adds the usual install places to PATH once', () => {
    expect(withFallbackPath('/usr/bin:/opt/homebrew/bin', '/Users/t')).toBe('/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/t/.local/bin:/Users/t/.lmstudio/bin')
  })
})
