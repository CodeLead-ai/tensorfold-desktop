import { describe, expect, it } from 'vitest'
import { parseUpdateCheck } from '@shared/update'

const BIN = '/venv/bin/tensorfold'

/** The lines update.py prints for `tensorfold update --check` (0.3.6.2 and 0.5.0 alike). */
describe('tensorfold update --check', () => {
  it('reads "is the latest release"', () => {
    expect(parseUpdateCheck({ output: '[tensorfold] TensorFold 0.5.0 is the latest release\n', code: 0, binary: BIN, at: 1 })).toEqual({
      at: 1,
      ok: true,
      current: '0.5.0',
      latest: '0.5.0',
      newer: false,
      command: '/venv/bin/tensorfold update',
      notesUrl: 'https://github.com/ashhart/TensorFold/releases/tag/v0.5.0',
      error: null,
      output: '[tensorfold] TensorFold 0.5.0 is the latest release\n'
    })
  })

  it('reads "is available"', () => {
    expect(parseUpdateCheck({ output: '[tensorfold] TensorFold 0.5.0 is available (this is 0.3.6.2)\n', code: 0, binary: BIN, at: 1 })).toMatchObject({
      ok: true,
      current: '0.3.6.2',
      latest: '0.5.0',
      newer: true,
      notesUrl: 'https://github.com/ashhart/TensorFold/releases/tag/v0.5.0'
    })
  })

  it('says why there is no answer', () => {
    const offline = parseUpdateCheck({
      output: '[tensorfold] could not reach GitHub to look for releases (https://api.github.com/repos/ashhart/TensorFold/releases/latest)\n',
      code: 1,
      binary: BIN,
      at: 1
    })
    expect(offline).toMatchObject({ ok: false, newer: false, latest: null, error: 'could not reach GitHub to look for releases (https://api.github.com/repos/ashhart/TensorFold/releases/latest)' })
    expect(parseUpdateCheck({ output: '', code: null, binary: BIN, at: 1, spawnError: 'spawn EACCES' }).error).toBe('spawn EACCES')
    expect(parseUpdateCheck({ output: '', code: 2, binary: BIN, at: 1 }).error).toBe('exited with code 2')
  })
})
