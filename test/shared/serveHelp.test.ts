import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { helpSwitches, missingFlags, otherFlags, parseServeHelp, takesValue, unknownFlags } from '@shared/serveHelp'

const help = (version: string): string => readFileSync(join(__dirname, '..', 'fixtures', `tensorfold-serve-help-${version}.txt`), 'utf8')

describe('serve --help, as the installed binary prints it', () => {
  const v050 = parseServeHelp(help('0.5.0'))
  const v0362 = parseServeHelp(help('0.3.6.2'))
  const byCli = (flags: typeof v050, cli: string): (typeof v050)[number] | undefined => flags.find((f) => f.cli === cli)

  it('lists every flag in order, --help left out', () => {
    expect(v050).toHaveLength(38)
    expect(v0362).toHaveLength(34)
    expect(v050[0]?.cli).toBe('--host')
    expect(v050[v050.length - 1]?.cli).toBe('--kv-dtype')
    expect(v050.some((f) => f.cli === '--help')).toBe(false)
  })

  it('reads a value, a choice, a switch and a --no- pair, with their help, default and group', () => {
    expect(byCli(v050, '--host')).toEqual({
      cli: '--host',
      negative: null,
      metavar: 'HOST',
      choices: null,
      help: 'address to listen on (0.0.0.0: every interface)',
      defaultText: '127.0.0.1',
      group: 'endpoint'
    })
    expect(byCli(v050, '--reasoning-effort')).toMatchObject({ choices: ['low', 'medium', 'xhigh'], metavar: null, defaultText: 'None', group: 'generation (requests can override each of these)' })
    expect(byCli(v050, '--reasoning-effort')?.help).toMatch(/^for chat templates that take one \(Qwen3\.8\); default: the template's own \(Qwen3\.8's is xhigh\)/)
    expect(byCli(v0362, '--reasoning-effort')?.defaultText).toBe('medium')
    expect(byCli(v050, '--thinking')).toMatchObject({ negative: '--no-thinking', metavar: null, choices: null, defaultText: 'True' })
    expect(byCli(v050, '--vision')).toMatchObject({ metavar: null, defaultText: 'False', help: 'enable image input for Qwen3.5/3.8 dense vision checkpoints' })
    expect(byCli(v050, '--ssd-experts')).toMatchObject({ metavar: 'GIB', defaultText: 'None' })
    expect(byCli(v050, '--port')).toMatchObject({ metavar: 'PORT', help: '', defaultText: null })
    expect(byCli(v050, '--kv-dtype')?.group).toBe('NVIDIA GPUs (DGX Spark)')
  })

  it("keeps a help text's own parenthesised default, and takes argparse's last one", () => {
    expect(byCli(v050, '--name')).toMatchObject({ help: "model id clients ask for (default: the model's name)", defaultText: '' })
    expect(byCli(v050, '--decode-share')).toMatchObject({ defaultText: 'None' })
    expect(byCli(v050, '--decode-share')?.help).toContain('(default 0.25; 0: whole prompts first, as 0.3.6.2)')
    expect(byCli(v050, '--snapshot-dir')?.defaultText).toBe('/Users/peter/.cache/tensorfold/prefix-snapshots')
  })

  it('knows the switches, and which flags take a value', () => {
    const switches = helpSwitches(v050)
    expect(switches.has('--no-thinking')).toBe(true)
    expect(switches.has('--min-p')).toBe(true)
    expect(helpSwitches(v0362).has('--min-p')).toBe(false)
    expect(takesValue(byCli(v050, '--min-p')!)).toBe(true)
    expect(takesValue(byCli(v050, '--lane-kernels')!)).toBe(true)
    expect(takesValue(byCli(v050, '--vision')!)).toBe(false)
  })

  it("compares with the app's table: nothing unknown in 0.5.0, four flags missing from 0.3.6.2", () => {
    expect(unknownFlags(v050)).toEqual([])
    expect(missingFlags(v050)).toEqual([])
    expect(missingFlags(v0362).map((f) => f.cli)).toEqual(['--vision', '--vision-urls', '--min-p', '--decode-share'])
  })

  it("finds a newer TensorFold's flags the table lacks", () => {
    const newer = help('0.5.0').replace(
      '  --no-update-check ',
      '  --future-share SHARE  a flag from a later release (default: 0.5)\n  --turbo, --no-turbo  another one (default: False)\n  --no-update-check '
    )
    const flags = parseServeHelp(newer)
    expect(unknownFlags(flags)).toEqual([
      { cli: '--future-share', negative: null, metavar: 'SHARE', choices: null, help: 'a flag from a later release', defaultText: '0.5', group: 'drafting and caches' },
      { cli: '--turbo', negative: '--no-turbo', metavar: null, choices: null, help: 'another one', defaultText: 'False', group: 'drafting and caches' }
    ])
    expect(otherFlags(flags)).toEqual([
      { cli: '--future-share', takesValue: true },
      { cli: '--turbo', takesValue: false }
    ])
    expect(otherFlags(null)).toEqual([])
  })

  it('reads nothing from text that is not argparse help', () => {
    expect(parseServeHelp('tensorfold 0.3.6.2\n')).toEqual([])
    expect(parseServeHelp('')).toEqual([])
  })
})
