/**
 * Runs `tensorfold update --check` for the Settings view. The CLI reaches api.github.com; the app only reads
 * what it prints.
 */
import { execFile } from 'node:child_process'
import { parseUpdateCheck, type UpdateCheck } from '@shared/update'
import { isScript } from './ProcessManager'

export function runUpdateCheck(binary: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<UpdateCheck> {
  const script = isScript(binary)
  const childEnv = { ...env, NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1', ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  const [command, args] = script ? [process.execPath, [binary, 'update', '--check']] : [binary, ['update', '--check']]
  return new Promise((resolve) => {
    execFile(command, args, { env: childEnv, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      const spawnError = error && typeof error.code === 'string' ? error.message : error?.killed ? `no answer in ${timeoutMs / 1000} s` : null
      resolve(parseUpdateCheck({ output: `${stdout}${stderr}`, code, binary, at: Date.now(), spawnError }))
    })
  })
}
