/**
 * An app opened from Finder gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so neither `tensorfold` in a
 * venv nor LM Studio's `lms` would be found. Ask the user's login shell for its environment once, and add
 * the usual install places as a fallback.
 */
import { execFile } from 'node:child_process'
import { delimiter, join } from 'node:path'

const MARK = '__TFDESK_ENV__'

export function parseEnvDump(output: string): Record<string, string> {
  const start = output.indexOf(MARK)
  const end = output.lastIndexOf(MARK)
  if (start < 0 || end <= start) return {}
  const env: Record<string, string> = {}
  for (const line of output.slice(start + MARK.length, end).split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

export function withFallbackPath(path: string | undefined, home: string): string {
  const dirs = (path ?? '').split(delimiter).filter(Boolean)
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.lmstudio', 'bin')]) {
    if (!dirs.includes(extra)) dirs.push(extra)
  }
  return dirs.join(delimiter)
}

export function loginShellEnv(base: NodeJS.ProcessEnv, home: string, timeoutMs = 5000): Promise<NodeJS.ProcessEnv> {
  const shell = base['SHELL'] || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' '${MARK}'; env; printf '%s' '${MARK}'`],
      { timeout: timeoutMs, env: { ...base, DISABLE_AUTO_UPDATE: 'true' }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const shellEnv = error ? {} : parseEnvDump(stdout)
        const merged: NodeJS.ProcessEnv = { ...base, ...shellEnv }
        merged['PATH'] = withFallbackPath(merged['PATH'], home)
        resolve(merged)
      }
    )
  })
}
