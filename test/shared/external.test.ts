import { describe, expect, it } from 'vitest'
import { applyPreset, buildServeArgv, emptyConfig } from '@shared/config'
import { configOfCommand, parseLstart, serveArgv, serveCommand, sessionStart } from '@shared/external'

const MODEL = '/Users/peter/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit'
const BIN = '/Users/peter/Projects/codelead-bench/tensorfold-venv/bin/tensorfold'
/** `ps -o command=` of the bench's server on 2026-11-12, and of the caffeinate child that carries its command line. */
const PYTHON = `/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python ${BIN} serve ${MODEL} --port 8080 --context 89600 --reasoning-effort medium --no-update-check`
const CAFFEINATE = `caffeinate -i -s ${BIN} serve ${MODEL} --port 8080 --context 89600 --reasoning-effort medium --no-update-check`

describe('a server the app did not start, from ps', () => {
  it('finds `tensorfold serve` in a Python command line, and not in the caffeinate child that only carries it', () => {
    expect(serveCommand(PYTHON)).toEqual({ binary: BIN, words: [MODEL, '--port', '8080', '--context', '89600', '--reasoning-effort', 'medium', '--no-update-check'] })
    expect(serveCommand(CAFFEINATE)).toBeNull()
    expect(serveCommand(`${BIN} pull z-lab/Qwen3.8-27B-DFlash2`)).toBeNull()
    expect(serveCommand('/usr/bin/vim tensorfold-notes.txt')).toBeNull()
  })

  it('knows the mock CLI only when asked (the mock profile)', () => {
    const mock = '/usr/local/bin/node /x/mock/fake-tensorfold.mjs serve /x/model --port 9000'
    expect(serveCommand(mock)).toBeNull()
    expect(serveCommand(mock, true)?.binary).toBe('/x/mock/fake-tensorfold.mjs')
  })

  it("reads the bench's command back into the endorsed preset", () => {
    const { argv, config } = configOfCommand((serveCommand(PYTHON) as { words: string[] }).words)
    expect(argv).toEqual(buildServeArgv(applyPreset(emptyConfig(MODEL), 'endorsed')))
    expect(config).toEqual(applyPreset(emptyConfig(MODEL), 'endorsed'))
  })

  it('joins back the words of a path that held spaces, but not a number or a choice', () => {
    expect(serveArgv(['/Users/p/My', 'Models/q', '--snapshot-dir', '/tmp/a', 'b', '--port', '8081', '--no-drafts', '--lane-kernels', 'off'])).toEqual([
      'serve', '/Users/p/My Models/q', '--snapshot-dir', '/tmp/a b', '--port', '8081', '--no-drafts', '--lane-kernels', 'off'
    ])
    // A switch followed by the model, and --flag=value forms.
    expect(serveArgv(['--no-drafts', '/m', '--port=9000'])).toEqual(['serve', '/m', '--no-drafts', '--port=9000'])
  })

  it("keeps a newer TensorFold's flags when the binary lists them; otherwise shows the model alone", () => {
    const others = [{ cli: '--turbo', takesValue: false }]
    expect(configOfCommand(['/m', '--turbo', '--port', '8081'], others).config).toMatchObject({ model: '/m', endpoint: { port: 8081 }, extra: { '--turbo': true } })
    expect(configOfCommand(['/m', '--turbo', '--port', '8081']).config).toEqual(emptyConfig('/m'))
  })

  it("reads ps's start time, in local time", () => {
    expect(parseLstart('Sat Nov  7 08:25:15 2026')).toBe(new Date(2026, 10, 7, 8, 25, 15).getTime())
    expect(parseLstart('Thu Oct 24 22:16:53 2026')).toBe(new Date(2026, 9, 24, 22, 16, 53).getTime())
    expect(parseLstart('yesterday')).toBeNull()
  })

  it("finds where the current session starts in a log that holds earlier ones", () => {
    const one = '[tensorfold] memory budget 44.8 GiB: …\n[tensorfold] serving a …\n[tensorfold] done req-1 …\n'
    const two = '[tensorfold] memory budget 44.8 GiB: …\n[tensorfold] serving b …\n'
    expect(sessionStart(one)).toBe(0)
    expect(sessionStart(one + two)).toBe(one.length)
    expect(sessionStart('Traceback (most recent call last):\n')).toBe(0)
  })
})
