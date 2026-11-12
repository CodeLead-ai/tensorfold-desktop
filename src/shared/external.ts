/**
 * A `tensorfold serve` the app did not start (a bench script's, say): its command line as `ps` prints it, read back
 * into a configuration, and where its current session starts in the log file its output goes to. Pure.
 */
import { ArgvError, FLAGS, emptyConfig, parseServeArgv, type OtherFlag, type ServeConfig } from './config'

/** What the app knows of a server it did not start. */
export interface ExternalInfo {
  /** The folder it was started in. */
  cwd: string | null
  /** The command line as `ps` prints it (arguments joined by spaces). */
  psCommand: string
  /** Where its output goes, when that is a file the app follows; null for a terminal or a pipe. */
  logFile: string | null
}

const BINARY = /(^|\/)tensorfold$/
const MOCK_BINARY = /(^|\/)fake-tensorfold\.mjs$/
/** Kinds whose value is one word; the others (paths, names) may hold spaces `ps` cannot tell from separators. */
const ONE_WORD = new Set(['int', 'float', 'intOrAuto', 'choice'])
const SWITCHES = new Set(FLAGS.filter((f) => f.kind === 'bool' || f.kind === 'tristate').flatMap((f) => [f.cli, f.cli.replace(/^--/, '--no-')]))
const ONE_WORD_FLAGS = new Set(FLAGS.filter((f) => ONE_WORD.has(f.kind)).map((f) => f.cli))

/**
 * `<…>/tensorfold serve <model> [flags]` out of a `ps` command line, else null. A wrapper that only carries the
 * command (caffeinate's child, which holds the stay-awake assertion while the server runs as its parent) is not it.
 */
export function serveCommand(command: string, allowMock = false): { binary: string; words: string[] } | null {
  const words = command.trim().split(/\s+/)
  if (/(^|\/)(caffeinate|nohup|sudo|env|time)$/.test(words[0] ?? '')) return null
  const at = words.findIndex((w, i) => (BINARY.test(w) || (allowMock && MOCK_BINARY.test(w))) && words[i + 1] === 'serve')
  return at < 0 ? null : { binary: words[at] as string, words: words.slice(at + 2) }
}

/**
 * The argv of `serve` from the words after it. `ps` joins arguments with spaces, so a path with a space comes apart:
 * words are joined back up to the next flag, except after a flag whose value is one word (a number, a choice).
 */
export function serveArgv(words: readonly string[], others: readonly OtherFlag[] = []): string[] {
  const takesValue = (flag: string): boolean => !SWITCHES.has(flag) && (others.find((o) => o.cli === flag)?.takesValue ?? true)
  const flags: string[] = []
  const positional: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if (!word.startsWith('--') || word.includes('=')) {
      if (word.startsWith('--')) flags.push(word)
      else positional.push(word)
      continue
    }
    flags.push(word)
    if (!takesValue(word) || i + 1 >= words.length || (words[i + 1] as string).startsWith('--')) continue
    if (ONE_WORD_FLAGS.has(word)) {
      flags.push(words[++i] as string)
      continue
    }
    const value: string[] = []
    while (i + 1 < words.length && !(words[i + 1] as string).startsWith('--')) value.push(words[++i] as string)
    flags.push(value.join(' '))
  }
  return ['serve', ...(positional.length ? [positional.join(' ')] : []), ...flags]
}

/** The configuration a `ps` command line runs; flags the table does not know make it the model alone. */
export function configOfCommand(words: readonly string[], others: readonly OtherFlag[] = []): { argv: string[]; config: ServeConfig } {
  const argv = serveArgv(words, others)
  try {
    return { argv, config: parseServeArgv(argv, others) }
  } catch (e) {
    if (!(e instanceof ArgvError)) throw e
    return { argv, config: emptyConfig(argv[1]?.startsWith('--') ? '' : (argv[1] ?? '')) }
  }
}

/** `ps -o lstart=` (`Sat Nov  7 08:25:15 2026`, local time) as ms since the epoch; null when it does not parse. */
export function parseLstart(text: string): number | null {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  if (!m) return null
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1] as string)
  if (month < 0) return null
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
}

/**
 * Where the current session starts in a log file that may hold earlier ones (a script appending with `>>`): the
 * last `[tensorfold] memory budget` line, TensorFold's first on a Mac; else the start of the file.
 */
export function sessionStart(text: string): number {
  const marker = '[tensorfold] memory budget '
  const at = text.lastIndexOf(`\n${marker}`)
  return at >= 0 ? at + 1 : 0
}
