/**
 * One `tensorfold pull` at a time (SPEC §3.7). The child downloads from huggingface.co into the Hugging Face
 * cache; the app only reads its output. Progress bars on stderr are redrawn with carriage returns.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ActionResult } from '@shared/api'
import { isRepoId, parseProgress, parsePullResult, type PullState } from '@shared/pull'
import { isScript } from './ProcessManager'

const KEEP = 200

export class Puller extends EventEmitter<{ update: [PullState] }> {
  state: PullState | null = null
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly env: NodeJS.ProcessEnv) {
    super()
  }

  get running(): boolean {
    return this.state?.status === 'running'
  }

  start(binary: string, repo: string): ActionResult {
    if (this.running) return { ok: false, error: `already pulling ${this.state?.repo}` }
    const id = repo.trim()
    if (!isRepoId(id)) return { ok: false, error: `${id || 'that'} is not a Hugging Face repo id (owner/name)` }
    this.state = { repo: id, status: 'running', startedAt: Date.now(), endedAt: null, lines: [], progress: null, result: null, exitCode: null }
    const script = isScript(binary)
    const env = { ...this.env, PYTHONUNBUFFERED: '1', ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
    const child = script ? spawn(process.execPath, [binary, 'pull', id], { env }) : spawn(binary, ['pull', id], { env })
    this.child = child
    const take = (text: string, fromStderr: boolean): void => {
      const state = this.state as PullState
      for (const segment of text.split(/\r|\n/)) {
        if (segment.trim() === '') continue
        const progress = fromStderr ? parseProgress(segment) : null
        if (progress) {
          state.progress = progress
          continue
        }
        state.lines.push(segment)
        if (state.lines.length > KEEP) state.lines.splice(0, state.lines.length - KEEP)
        state.result = parsePullResult(segment) ?? state.result
      }
      this.schedule()
    }
    child.stdout?.on('data', (chunk: Buffer) => take(chunk.toString('utf8'), false))
    child.stderr?.on('data', (chunk: Buffer) => take(chunk.toString('utf8'), true))
    child.on('error', (e) => this.finish(null, e.message))
    child.on('close', (code) => this.finish(code, null))
    this.emitNow()
    return { ok: true }
  }

  cancel(): void {
    if (!this.running || !this.child) return
    ;(this.state as PullState).status = 'cancelled'
    this.child.kill('SIGTERM')
  }

  private finish(code: number | null, error: string | null): void {
    const state = this.state
    if (!state || state.endedAt !== null) return
    state.endedAt = Date.now()
    state.exitCode = code
    if (error) state.lines.push(error)
    if (state.status !== 'cancelled') state.status = code === 0 ? 'done' : 'failed'
    this.child = null
    this.emitNow()
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.emitNow(), 100)
  }

  private emitNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.state) this.emit('update', { ...this.state, lines: this.state.lines.slice() })
  }
}
