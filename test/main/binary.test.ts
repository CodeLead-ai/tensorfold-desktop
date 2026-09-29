import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { candidatePaths, findBinary, runVersion } from '../../src/main/binary'
import { MOCK } from '../helpers'

const home = mkdtempSync(join(tmpdir(), 'tfdesk-home-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function fakeTensorfold(path: string, version: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "tensorfold ${version}"\n`)
  chmodSync(path, 0o755)
}

describe('finding tensorfold', () => {
  it('finds a venv under ~/Projects when it is not on PATH', async () => {
    const venvBinary = join(home, 'Projects', 'bench', 'tensorfold-venv', 'bin', 'tensorfold')
    fakeTensorfold(venvBinary, '0.3.6.2')
    expect(candidatePaths({ PATH: '/usr/bin' }, home)).toContain(venvBinary)
    const found = await findBinary({ configured: '', mockBinary: null, env: { PATH: '/usr/bin:/bin' }, home })
    expect(found).toMatchObject({ path: venvBinary, source: 'found', version: '0.3.6.2', error: null })
  })

  it('prefers PATH, and the configured path over everything', async () => {
    const onPath = join(home, 'bin', 'tensorfold')
    fakeTensorfold(onPath, '0.4.0')
    const env = { PATH: `${join(home, 'bin')}:/usr/bin:/bin` }
    expect(await findBinary({ configured: '', mockBinary: null, env, home })).toMatchObject({ path: onPath, source: 'path', version: '0.4.0' })
    const configured = join(home, 'Projects', 'bench', 'tensorfold-venv', 'bin', 'tensorfold')
    expect(await findBinary({ configured, mockBinary: null, env, home })).toMatchObject({ path: configured, source: 'settings', version: '0.3.6.2' })
  })

  it('says so when the configured path is not executable', async () => {
    const found = await findBinary({ configured: join(home, 'nope'), mockBinary: null, env: { PATH: '' }, home })
    expect(found.error).toMatch(/not an executable file/)
  })

  it('runs the mock with the running Node', async () => {
    expect(await runVersion(MOCK, process.env)).toBe('0.3.6.2')
    expect(await findBinary({ configured: '', mockBinary: MOCK, env: process.env, home })).toMatchObject({ path: MOCK, source: 'mock', version: '0.3.6.2' })
  })
})
