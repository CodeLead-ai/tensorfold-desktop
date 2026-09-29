/**
 * Finding and asking the `tensorfold` binary (SPEC §2.1): the path in Settings, else `which tensorfold` on
 * the login shell's PATH, else a venv under ~/Projects or ~ that holds one. No CodeLead path is written here;
 * a venv such as ~/Projects/codelead-bench/tensorfold-venv is found by looking.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { BinaryInfo } from '@shared/api'
import { isScript } from './ProcessManager'

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (isScript(path)) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

/** Places a tensorfold may live, most likely first. */
export function candidatePaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const onPath = (env['PATH'] ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'tensorfold'))
  const usual = [join(home, '.local', 'bin', 'tensorfold'), '/opt/homebrew/bin/tensorfold', '/usr/local/bin/tensorfold']
  const venvs: string[] = []
  const isVenv = (dir: string): boolean => /venv/i.test(dir.split('/').pop() ?? '')
  for (const dir of subdirs(home).filter(isVenv)) venvs.push(join(dir, 'bin', 'tensorfold'))
  for (const project of subdirs(join(home, 'Projects'))) {
    for (const dir of subdirs(project).filter(isVenv)) venvs.push(join(dir, 'bin', 'tensorfold'))
  }
  return [...new Set([...onPath, ...usual, ...venvs])]
}

export function runVersion(binary: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<string | null> {
  const script = isScript(binary)
  const quiet = { ...env, PYTHONDONTWRITEBYTECODE: '1', TENSORFOLD_NO_UPDATE_CHECK: '1', ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  const [command, args] = script ? [process.execPath, [binary, '--version']] : [binary, ['--version']]
  return new Promise((resolve) => {
    execFile(command, args, { env: quiet, timeout: timeoutMs }, (error, stdout) => {
      if (error) return resolve(null)
      const m = /tensorfold\s+(\S+)/.exec(stdout)
      resolve(m ? (m[1] as string) : stdout.trim() || null)
    })
  })
}

export async function findBinary(options: {
  configured: string
  mockBinary: string | null
  env: NodeJS.ProcessEnv
  home: string
}): Promise<BinaryInfo> {
  const { configured, mockBinary, env, home } = options
  const searched: string[] = []
  let path: string | null = null
  let source: BinaryInfo['source'] = null
  if (configured) {
    searched.push(configured)
    if (!executable(configured)) {
      return { path: configured, source: 'settings', version: null, error: `${configured} is not an executable file`, searched }
    }
    path = configured
    source = 'settings'
  } else if (mockBinary) {
    searched.push(mockBinary)
    path = mockBinary
    source = 'mock'
  } else {
    const onPath = new Set((env['PATH'] ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'tensorfold')))
    for (const candidate of candidatePaths(env, home)) {
      searched.push(candidate)
      if (executable(candidate)) {
        path = candidate
        source = onPath.has(candidate) ? 'path' : 'found'
        break
      }
    }
  }
  if (!path) return { path: null, source: null, version: null, error: 'no tensorfold found: set its path in Settings', searched }
  const version = await runVersion(path, env)
  return { path, source, version, error: version ? null : `${path} did not answer --version`, searched }
}
