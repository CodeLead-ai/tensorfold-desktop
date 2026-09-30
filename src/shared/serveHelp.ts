/**
 * What the installed `tensorfold serve --help` lists: argparse's help, one entry per flag, in its groups. The
 * form offers the flags the binary has: a flag of the app's table (src/shared/config.ts) that the binary lacks
 * is marked, and a flag the binary has that the table lacks (a newer TensorFold's) gets a plain field.
 */
import { FLAGS, type FlagSpec, type OtherFlag } from './config'

export interface HelpFlag {
  /** `--min-p` */
  cli: string
  /** `--no-thinking`, for a flag written `--thinking, --no-thinking`. */
  negative: string | null
  /** `MIN_P`; null for a switch or a choice. */
  metavar: string | null
  /** `{low,medium,xhigh}` as a list. */
  choices: string[] | null
  /** The help text without argparse's closing `(default: …)`. */
  help: string
  /** What argparse's `(default: …)` says, as printed (`None`, `False`, `auto`, …). */
  defaultText: string | null
  /** The section it is listed under: `endpoint`, `generation (requests can override each of these)`, … */
  group: string
}

const HEADING = /^(\S.*):$/
const ENTRY = /^ {2}(-\S.*)$/
const CONTINUED = /^ {3,}(\S.*)$/

/** Splits `--flag METAVAR`, `--flag {a,b}` or `--flag` into the switch and what follows it. */
function invocation(part: string): { cli: string; metavar: string | null; choices: string[] | null } {
  const [cli = '', ...rest] = part.trim().split(/\s+/)
  const arg = rest.join(' ')
  if (arg === '') return { cli, metavar: null, choices: null }
  const choices = /^\{(.*)\}$/.exec(arg)
  return choices ? { cli, metavar: null, choices: (choices[1] as string).split(',') } : { cli, metavar: arg, choices: null }
}

function finish(entry: { parts: string[]; help: string[]; group: string }): HelpFlag | null {
  const forms = entry.parts.map(invocation).filter((f) => f.cli.startsWith('--'))
  const main = forms[0]
  if (!main || main.cli === '--help') return null
  const negative = forms.find((f) => f !== main && f.cli === main.cli.replace(/^--/, '--no-'))?.cli ?? null
  let help = entry.help.join(' ').replace(/\s+/g, ' ').trim()
  let defaultText: string | null = null
  const at = help.lastIndexOf('(default: ')
  if (at >= 0 && help.endsWith(')')) {
    defaultText = help.slice(at + '(default: '.length, -1)
    help = help.slice(0, at).trim()
  }
  return { cli: main.cli, negative, metavar: main.metavar, choices: main.choices, help, defaultText, group: entry.group }
}

/** Every flag of a `serve --help` text, in its order (`--help` itself left out). */
export function parseServeHelp(text: string): HelpFlag[] {
  const flags: HelpFlag[] = []
  let group = ''
  let entry: { parts: string[]; help: string[]; group: string } | null = null
  const close = (): void => {
    const flag = entry ? finish(entry) : null
    if (flag) flags.push(flag)
    entry = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const heading = HEADING.exec(line)
    if (heading && !line.startsWith('usage:')) {
      close()
      group = heading[1] as string
      continue
    }
    const start = ENTRY.exec(line)
    if (start) {
      close()
      // The switches end where argparse's column gap (two or more spaces) starts the help.
      const [head = '', ...helpStart] = (start[1] as string).split(/ {2,}/)
      entry = { parts: head.split(', '), help: helpStart.length ? [helpStart.join(' ')] : [], group }
      continue
    }
    const more = CONTINUED.exec(line)
    if (more && entry) {
      entry.help.push(more[1] as string)
      continue
    }
    close()
  }
  close()
  return flags
}

/** Every switch the help lists, the `--no-` forms too. */
export function helpSwitches(flags: readonly HelpFlag[]): Set<string> {
  const out = new Set<string>()
  for (const f of flags) {
    out.add(f.cli)
    if (f.negative) out.add(f.negative)
  }
  return out
}

/** Whether the flag takes a value (`--flag VALUE`), as opposed to a switch. */
export function takesValue(flag: HelpFlag): boolean {
  return flag.metavar !== null || flag.choices !== null
}

/** The binary's flags that the app's table does not have, in the help's order. */
export function unknownFlags(flags: readonly HelpFlag[]): HelpFlag[] {
  const known = new Set(FLAGS.map((f) => f.cli))
  return flags.filter((f) => !known.has(f.cli))
}

/** The app's flags that the binary does not list. */
export function missingFlags(flags: readonly HelpFlag[]): FlagSpec[] {
  const listed = helpSwitches(flags)
  return FLAGS.filter((f) => !listed.has(f.cli))
}

/** The unknown flags as parseServeArgv takes them. */
export function otherFlags(flags: readonly HelpFlag[] | null): OtherFlag[] {
  return flags ? unknownFlags(flags).map((f) => ({ cli: f.cli, takesValue: takesValue(f) })) : []
}
