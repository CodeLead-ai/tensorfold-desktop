/**
 * `tensorfold update --check`: the CLI asks GitHub whether a newer release exists. The app runs it only when the
 * user asks (the one outbound connection besides a pull, and it is the CLI's, not the app's), and never
 * installs: upgrading stays the user's `tensorfold update`, since it changes the environment a bench runs in.
 */

export const RELEASES = 'https://github.com/ashhart/TensorFold/releases'

export interface UpdateCheck {
  at: number
  /** GitHub answered. */
  ok: boolean
  current: string | null
  latest: string | null
  newer: boolean
  /** The command that installs `latest`: `<binary> update`. */
  command: string
  /** The release notes of `latest`. */
  notesUrl: string | null
  error: string | null
  /** What the CLI printed, stdout then stderr. */
  output: string
}

const strip = (line: string): string => line.replace(/^\[tensorfold\] /, '')

/** The CLI's answer, as update.py prints it (the same in 0.3.6.2 and 0.5.0). */
export function parseUpdateCheck(input: { output: string; code: number | null; binary: string; at: number; spawnError?: string | null }): UpdateCheck {
  const { output, code, binary, at } = input
  const base = { at, command: `${binary} update`, output }
  const available = /TensorFold (\S+) is available \(this is (\S+)\)/.exec(output)
  if (available) {
    const latest = available[1] as string
    return { ...base, ok: true, current: available[2] as string, latest, newer: true, notesUrl: `${RELEASES}/tag/v${latest}`, error: null }
  }
  const current = /TensorFold (\S+) is the latest release/.exec(output)
  if (current) {
    const latest = current[1] as string
    return { ...base, ok: true, current: latest, latest, newer: false, notesUrl: `${RELEASES}/tag/v${latest}`, error: null }
  }
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  const error = input.spawnError ?? (lines.length ? strip(lines[lines.length - 1] as string) : `exited with code ${code}`)
  return { ...base, ok: false, current: null, latest: null, newer: false, notesUrl: null, error }
}
