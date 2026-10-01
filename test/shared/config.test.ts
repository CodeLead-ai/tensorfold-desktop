import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ArgvError,
  FLAGS,
  PRESETS,
  applyPreset,
  buildServeArgv,
  buildServeEnv,
  emptyConfig,
  formatCommandLine,
  parseServeArgv,
  presetOf,
  shellQuote,
  type ServeConfig
} from '@shared/config'
import { missingFlags, parseServeHelp } from '@shared/serveHelp'

const MODEL = '/Users/peter/.lmstudio/models/lmstudio-community/Qwen3.8-27B-MLX-8bit'
const help = (version: string): string => readFileSync(join(__dirname, '..', 'fixtures', `tensorfold-serve-help-${version}.txt`), 'utf8')

function everyFlag(): ServeConfig {
  return {
    model: MODEL,
    endpoint: { host: '0.0.0.0', port: 8081, name: 'qwen', alias: ['a', 'b'], vision: true, visionUrls: true },
    generation: { context: 65536, maxTokens: 2048, temperature: 0.6, topP: 0.95, topK: 20, minP: 0.05, thinking: false, reasoningEffort: 'xhigh', thinkingBudget: 512 },
    drafting: {
      noDrafts: true, drafter: 'none', drafterBits: 0, mtpDrafts: 3, mtpConfidence: 0.3, laneKernels: 'off', promptCacheGib: 4,
      checkpointSlots: 16, spillGib: 10, snapshotDir: '/tmp/snaps', maxSnapshots: 2, parallel: 'auto', decodeShare: 0.5, mlxCacheGib: 6,
      ssdExperts: 12.5, pleOnSsd: true, noUpdateCheck: true
    },
    nvidia: { backend: 'cuda', tp: 2, rank: 1, master: '10.0.0.2', masterPort: 29600, kvDtype: 'int8' },
    env: { memoryLimitGb: 51.8 }
  }
}

describe('the flag table', () => {
  it('lists every flag of the installed 0.5.0 `tensorfold serve --help`, in its order', () => {
    expect(FLAGS.map((f) => f.cli)).toEqual(parseServeHelp(help('0.5.0')).map((f) => f.cli))
  })

  it("marks the flags 0.3.6.2's serve --help lacks with the release that added them", () => {
    expect(missingFlags(parseServeHelp(help('0.3.6.2'))).map((f) => [f.cli, f.since])).toEqual([
      ['--vision', '0.3.6.3'],
      ['--vision-urls', '0.3.6.3'],
      ['--min-p', '0.5.0'],
      ['--decode-share', '0.3.6.3']
    ])
    expect(FLAGS.filter((f) => f.since).map((f) => f.cli)).toEqual(['--vision', '--vision-urls', '--min-p', '--decode-share'])
  })

  it('puts the CUDA-only flags in the NVIDIA group', () => {
    expect(FLAGS.filter((f) => f.group === 'nvidia').map((f) => f.cli)).toEqual(['--backend', '--tp', '--rank', '--master', '--master-port', '--kv-dtype'])
  })
})

describe('buildServeArgv', () => {
  it('renders the endorsed preset exactly (SPEC §3.1)', () => {
    const argv = buildServeArgv(applyPreset(emptyConfig(MODEL), 'endorsed'))
    expect(argv.join(' ')).toBe(`serve ${MODEL} --port 8080 --context 89600 --reasoning-effort medium --no-update-check`)
  })

  it('renders the serial reference as the endorsed flags plus --no-drafts', () => {
    const argv = buildServeArgv(applyPreset(emptyConfig(MODEL), 'serial'))
    expect(argv.join(' ')).toBe(`serve ${MODEL} --port 8080 --context 89600 --reasoning-effort medium --no-drafts --no-update-check`)
  })

  it('passes nothing but the model when nothing is set', () => {
    expect(buildServeArgv(emptyConfig(MODEL))).toEqual(['serve', MODEL])
  })

  it('renders every flag in help order, each in its form', () => {
    expect(buildServeArgv(everyFlag())).toEqual([
      'serve', MODEL,
      '--host', '0.0.0.0', '--port', '8081', '--name', 'qwen', '--alias', 'a', '--alias', 'b', '--vision', '--vision-urls',
      '--context', '65536', '--max-tokens', '2048', '--temperature', '0.6', '--top-p', '0.95', '--top-k', '20', '--min-p', '0.05', '--no-thinking',
      '--reasoning-effort', 'xhigh', '--thinking-budget', '512',
      '--no-drafts', '--drafter', 'none', '--drafter-bits', '0', '--mtp-drafts', '3', '--mtp-confidence', '0.3', '--lane-kernels', 'off',
      '--prompt-cache-gib', '4', '--checkpoint-slots', '16', '--spill-gib', '10', '--snapshot-dir', '/tmp/snaps', '--max-snapshots', '2',
      '--parallel', 'auto', '--decode-share', '0.5', '--mlx-cache-gib', '6', '--ssd-experts', '12.5', '--ple-on-ssd', '--no-update-check',
      '--backend', 'cuda', '--tp', '2', '--rank', '1', '--master', '10.0.0.2', '--master-port', '29600', '--kv-dtype', 'int8'
    ])
  })

  it('writes thinking as --thinking or --no-thinking, and nothing when unset', () => {
    const on = { ...emptyConfig(MODEL), generation: { thinking: true } }
    const off = { ...emptyConfig(MODEL), generation: { thinking: false } }
    expect(buildServeArgv(on)).toEqual(['serve', MODEL, '--thinking'])
    expect(buildServeArgv(off)).toEqual(['serve', MODEL, '--no-thinking'])
  })

  it('skips false switches, empty strings and empty lists', () => {
    const config: ServeConfig = {
      ...emptyConfig(MODEL),
      endpoint: { name: '', alias: [] },
      drafting: { noDrafts: false, pleOnSsd: false, noUpdateCheck: false }
    }
    expect(buildServeArgv(config)).toEqual(['serve', MODEL])
  })

  it('passes a numeric --parallel', () => {
    expect(buildServeArgv({ ...emptyConfig(MODEL), drafting: { parallel: 4 } })).toEqual(['serve', MODEL, '--parallel', '4'])
  })

  it("passes a newer TensorFold's flags (unknown to the table) after the rest, as set", () => {
    const config: ServeConfig = { ...emptyConfig(MODEL), generation: { context: 4096 }, extra: { '--future-share': '0.5', '--turbo': true, '--empty': '' } }
    expect(buildServeArgv(config)).toEqual(['serve', MODEL, '--context', '4096', '--future-share', '0.5', '--turbo'])
    expect(presetOf({ ...applyPreset(config, 'endorsed'), extra: { '--turbo': true } })).toBe('custom')
  })
})

describe('buildServeEnv', () => {
  it('sets TENSORFOLD_MEMORY_LIMIT_GB only when asked', () => {
    expect(buildServeEnv(emptyConfig(MODEL))).toEqual({})
    expect(buildServeEnv(everyFlag())).toEqual({ TENSORFOLD_MEMORY_LIMIT_GB: '51.8' })
  })
})

describe('formatCommandLine', () => {
  it('shows the command a user would type, env first', () => {
    const config = applyPreset(emptyConfig(MODEL), 'endorsed')
    config.env.memoryLimitGb = 51.8
    const line = formatCommandLine('/venv/bin/tensorfold', buildServeArgv(config), buildServeEnv(config))
    expect(line).toBe(
      `TENSORFOLD_MEMORY_LIMIT_GB=51.8 /venv/bin/tensorfold serve ${MODEL} --port 8080 --context 89600 --reasoning-effort medium --no-update-check`
    )
  })

  it('quotes words the shell would split or expand', () => {
    expect(shellQuote('/Users/p/My Models/q')).toBe(`'/Users/p/My Models/q'`)
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote('')).toBe(`''`)
    expect(shellQuote('$HOME')).toBe(`'$HOME'`)
    expect(shellQuote('z-lab/Qwen3.8-27B-DFlash2')).toBe('z-lab/Qwen3.8-27B-DFlash2')
  })
})

describe('parseServeArgv', () => {
  it('round-trips every flag', () => {
    const config = everyFlag()
    const parsed = parseServeArgv(buildServeArgv(config))
    expect(parsed).toEqual({ ...config, env: {} })
  })

  it('round-trips the presets', () => {
    for (const preset of PRESETS) {
      const config = applyPreset(emptyConfig(MODEL), preset.id)
      expect(buildServeArgv(parseServeArgv(buildServeArgv(config)))).toEqual(buildServeArgv(config))
    }
  })

  it('accepts --flag=value and a model after the flags', () => {
    const parsed = parseServeArgv(['serve', '--port=9000', '--context', '4096', MODEL])
    expect(parsed.model).toBe(MODEL)
    expect(parsed.endpoint.port).toBe(9000)
    expect(parsed.generation.context).toBe(4096)
  })

  it("keeps a newer TensorFold's flags when the binary lists them, and refuses them otherwise", () => {
    const argv = ['serve', MODEL, '--port', '8080', '--future-share', '0.5', '--turbo', '--context=4096']
    const others = [
      { cli: '--future-share', takesValue: true },
      { cli: '--turbo', takesValue: false }
    ]
    const parsed = parseServeArgv(argv, others)
    expect(parsed.extra).toEqual({ '--future-share': '0.5', '--turbo': true })
    expect(parsed.generation.context).toBe(4096)
    expect(buildServeArgv(parsed)).toEqual(['serve', MODEL, '--port', '8080', '--context', '4096', '--future-share', '0.5', '--turbo'])
    expect(() => parseServeArgv(argv)).toThrow(/unknown flag --future-share/)
    expect(parseServeArgv(['serve', MODEL]).extra).toBeUndefined()
  })

  it('rejects what tensorfold would reject', () => {
    expect(() => parseServeArgv(['serve', MODEL, '--port', 'x'])).toThrow(ArgvError)
    expect(() => parseServeArgv(['serve', MODEL, '--reasoning-effort', 'high'])).toThrow(ArgvError)
    expect(() => parseServeArgv(['serve', MODEL, '--nope'])).toThrow(ArgvError)
    expect(() => parseServeArgv(['serve', '--port', '1'])).toThrow(ArgvError)
    expect(() => parseServeArgv(['serve', MODEL, '--context'])).toThrow(ArgvError)
  })
})

describe('presets', () => {
  it('recognizes each preset and calls anything else custom', () => {
    expect(presetOf(applyPreset(emptyConfig(MODEL), 'endorsed'))).toBe('endorsed')
    expect(presetOf(applyPreset(emptyConfig(MODEL), 'serial'))).toBe('serial')
    const changed = applyPreset(emptyConfig(MODEL), 'endorsed')
    changed.generation.context = 65536
    expect(presetOf(changed)).toBe('custom')
    expect(presetOf(emptyConfig(MODEL))).toBe('custom')
  })

  it('keeps the model and the environment when a preset is applied, and drops flags the preset does not set', () => {
    const config = { ...everyFlag(), extra: { '--turbo': true as const } }
    const applied = applyPreset(config, 'endorsed')
    expect(applied.model).toBe(MODEL)
    expect(applied.env).toEqual({ memoryLimitGb: 51.8 })
    expect(applied.nvidia).toEqual({})
    expect(applied.extra).toBeUndefined()
  })

  it('keeps where the server listens across presets, and a preset stays itself with remote connections on', () => {
    const remote = applyPreset({ ...emptyConfig(MODEL), endpoint: { host: '0.0.0.0', port: 9000 } }, 'serial')
    expect(remote.endpoint).toEqual({ port: 8080, host: '0.0.0.0' })
    expect(presetOf(remote)).toBe('serial')
    expect(buildServeArgv(remote).join(' ')).toBe(`serve ${MODEL} --host 0.0.0.0 --port 8080 --context 89600 --reasoning-effort medium --no-drafts --no-update-check`)
    expect(presetOf(applyPreset(remote, 'endorsed'))).toBe('endorsed')
    expect(applyPreset(emptyConfig(MODEL), 'endorsed').endpoint).toEqual({ port: 8080 })
  })

  it('does not share state between applications of a preset', () => {
    const a = applyPreset(emptyConfig(MODEL), 'endorsed')
    a.endpoint.port = 1
    expect(applyPreset(emptyConfig(MODEL), 'endorsed').endpoint.port).toBe(8080)
  })
})
