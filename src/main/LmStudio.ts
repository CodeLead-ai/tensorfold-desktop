/**
 * Coexisting with LM Studio (SPEC §2.5, §3.8): what it has loaded (`lms ps --json`), and the user's commands
 * to unload it before serving and to restore it after. Nothing is hardcoded but `lms unload --all`, the
 * default unload; the restore command is whatever the user sets. Without lms, a clear message.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { parseLmsPs, type CommandResult, type LmStudioStatus } from '@shared/lmstudio'
import { shellQuote } from '@shared/config'
import { isScript } from './ProcessManager'

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (isScript(path)) return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export class LmStudio {
  constructor(private readonly opts: { env: NodeJS.ProcessEnv; home: string }) {}

  /** The configured lms, else `lms` on PATH, else LM Studio's own ~/.lmstudio/bin/lms. */
  resolve(configured: string): { path: string | null; searched: string[] } {
    const searched: string[] = []
    const candidates = configured
      ? [configured]
      : [...(this.opts.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'lms')), join(this.opts.home, '.lmstudio', 'bin', 'lms')]
    for (const c of candidates) {
      searched.push(c)
      if (isExecutable(c)) return { path: c, searched }
    }
    return { path: null, searched }
  }

  async status(configured: string): Promise<LmStudioStatus> {
    const checkedAt = Date.now()
    const { path, searched } = this.resolve(configured)
    if (!path) {
      return {
        available: false,
        lms: null,
        models: [],
        error: `LM Studio's lms was not found (looked at ${searched.slice(-2).join(', ')}${searched.length > 2 ? ' and PATH' : ''}). Set its path in Settings, or start the server without unloading.`,
        checkedAt
      }
    }
    const result = await this.exec(path, ['ps', '--json'], 20_000)
    if (result.code !== 0) return { available: false, lms: path, models: [], error: `lms ps failed: ${result.output.trim() || `exit ${result.code}`}`, checkedAt }
    try {
      return { available: true, lms: path, models: parseLmsPs(result.output), error: null, checkedAt }
    } catch (e) {
      return { available: false, lms: path, models: [], error: `lms ps --json: ${e instanceof Error ? e.message : String(e)}`, checkedAt }
    }
  }

  /** A user command through /bin/sh; a leading `lms` means the lms found above. */
  async run(command: string, configuredLms: string, timeoutMs = 15 * 60_000): Promise<CommandResult> {
    const text = command.trim()
    if (text === '') return { ok: false, command, code: null, output: '', error: 'no command set' }
    const lms = this.resolve(configuredLms).path
    let line = text
    const env: NodeJS.ProcessEnv = { ...this.opts.env }
    if (lms && /^lms(\s|$)/.test(text)) {
      line = `${isScript(lms) ? `${shellQuote(process.execPath)} ${shellQuote(lms)}` : shellQuote(lms)}${text.slice(3)}`
      if (isScript(lms)) env['ELECTRON_RUN_AS_NODE'] = '1'
      env['PATH'] = `${dirname(lms)}${delimiter}${env['PATH'] ?? ''}`
    }
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-c', line], { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.slice(-64 * 1024)
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
        resolve({ ok: !error, command: text, code, output, error: error ? (error.killed ? 'timed out' : `exit ${code ?? error.message}`) : null })
      })
    })
  }

  private exec(lms: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
    const script = isScript(lms)
    const [command, argv] = script ? [process.execPath, [lms, ...args]] : [lms, args]
    return new Promise((resolve) => {
      execFile(command, argv, { env: { ...this.opts.env, ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, timeout: timeoutMs }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: error ? `${stderr}${stdout}` || error.message : String(stdout) })
      })
    })
  }
}
