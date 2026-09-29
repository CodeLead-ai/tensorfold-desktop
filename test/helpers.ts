import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

export const ROOT = join(__dirname, '..')
export const MOCK = join(ROOT, 'mock', 'fake-tensorfold.mjs')
export const MOCK_MODEL = join(ROOT, 'mock', 'models', 'lmstudio-community', 'Qwen3.8-27B-MLX-8bit')

/** Fast settings for the mock in tests. */
export const FAST_MOCK_ENV = {
  MOCK_TENSORFOLD_LOAD_MS: '150',
  MOCK_TENSORFOLD_TIME_SCALE: '0.002',
  MOCK_TENSORFOLD_INTERVAL_MS: '20',
  MOCK_TENSORFOLD_TOKENS_PER_S: '2000',
  MOCK_TENSORFOLD_PULL_STEP_MS: '10'
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

export interface Run {
  child: ChildProcess
  stdout: string[]
  stderr: string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  waitFor(predicate: (line: string) => boolean, timeoutMs?: number): Promise<string>
}

/** Run the mock CLI and collect its output. */
export function runMock(args: string[], env: Record<string, string> = {}): Run {
  const child = spawn(process.execPath, [MOCK, ...args], { env: { ...process.env, ...FAST_MOCK_ENV, ...env } })
  const stdout: string[] = []
  const run: Run = {
    child,
    stdout,
    stderr: '',
    exited: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))),
    waitFor(predicate, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const found = stdout.find(predicate)
        if (found) return resolve(found)
        const timer = setTimeout(() => reject(new Error(`timed out; stdout so far:\n${stdout.join('\n')}\nstderr:\n${run.stderr}`)), timeoutMs)
        const onData = (): void => {
          const hit = stdout.find(predicate)
          if (hit) {
            clearTimeout(timer)
            child.stdout?.off('data', onData)
            resolve(hit)
          }
        }
        child.stdout?.on('data', onData)
      })
    }
  }
  let partial = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    partial += chunk.toString('utf8')
    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    stdout.push(...lines)
  })
  child.stderr?.on('data', (chunk: Buffer) => (run.stderr += chunk.toString('utf8')))
  return run
}
