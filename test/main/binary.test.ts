import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FLAGS } from '@shared/config'
import { candidatePaths, findBinary, runVersion, signalsReachPython } from '../../src/main/binary'
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
    // This stand-in answers `serve --help` with its version line, which lists no flag.
    expect(found).toMatchObject({ path: venvBinary, source: 'found', version: '0.3.6.2', error: null, serveHelp: null })
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

  it("runs the mock with the running Node, and reads its version's serve --help", async () => {
    expect(await runVersion(MOCK, process.env)).toBe('0.5.0')
    const found = await findBinary({ configured: '', mockBinary: MOCK, env: process.env, home })
    expect(found).toMatchObject({ path: MOCK, source: 'mock', version: '0.5.0' })
    expect(found.serveHelp?.map((f) => f.cli)).toEqual(FLAGS.map((f) => f.cli))
    const old = await findBinary({ configured: '', mockBinary: MOCK, env: { ...process.env, MOCK_TENSORFOLD_VERSION: '0.3.6.2' }, home })
    expect(old.version).toBe('0.3.6.2')
    expect(old.serveHelp).toHaveLength(FLAGS.length - 4)
    expect(old.serveHelp?.some((f) => f.cli === '--min-p')).toBe(false)
  })

  it('tells whether a signal reaches Python: an entry point, pip\'s /bin/sh preamble that execs it, or the mock', () => {
    const dir = join(home, 'signals')
    mkdirSync(dir, { recursive: true })
    const write = (name: string, text: string): string => (writeFileSync(join(dir, name), text), join(dir, name))
    expect(signalsReachPython(write('entry', '#!/Users/p/venv/bin/python\nimport sys\nfrom tensorfold.cli import main\n'))).toBe(true)
    expect(signalsReachPython(write('preamble', "#!/bin/sh\n'''exec' \"/Users/p/a very long path/bin/python3.14\" \"$0\" \"$@\"\n' '''\nimport sys\n"))).toBe(true)
    expect(signalsReachPython(write('wrapper', '#!/bin/sh\n/Users/p/venv/bin/tensorfold "$@"\n'))).toBe(false)
    expect(signalsReachPython(MOCK)).toBe(true)
    expect(signalsReachPython(join(dir, 'missing'))).toBe(false)
  })
})
