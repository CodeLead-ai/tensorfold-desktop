/**
 * Polls `GET /health` while the server serves (SPEC §3.3: every 2 s), backing off on failure.
 * Never passes reset_peak, so the peak stays the server's own.
 */
import { EventEmitter } from 'node:events'
import { parseHealth, type HealthSample } from '@shared/health'

export interface HealthPollerOptions {
  intervalMs: number
  maxIntervalMs?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

export class HealthPoller extends EventEmitter<{ sample: [HealthSample] }> {
  latest: HealthSample | null = null
  private timer: NodeJS.Timeout | null = null
  private base: string | null = null
  private failures = 0
  private generation = 0

  constructor(private readonly opts: HealthPollerOptions) {
    super()
  }

  get running(): boolean {
    return this.base !== null
  }

  /** Poll `${baseUrl}/health`; baseUrl has no /v1, e.g. http://127.0.0.1:8080. */
  start(baseUrl: string): void {
    if (this.base === baseUrl) return
    this.stop()
    this.base = baseUrl
    this.failures = 0
    this.latest = null
    void this.poll(++this.generation)
  }

  stop(): void {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.base = null
  }

  setInterval(ms: number): void {
    this.opts.intervalMs = ms
  }

  private async poll(generation: number): Promise<void> {
    const base = this.base
    if (generation !== this.generation || base === null) return
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const now = this.opts.now ?? Date.now
    let sample: HealthSample
    try {
      const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 1500) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const health = parseHealth(await res.json())
      if (!health) throw new Error('the answer is not a /health body')
      this.failures = 0
      sample = { at: now(), ok: true, health }
    } catch (e) {
      this.failures++
      const message = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)
      sample = { at: now(), ok: false, error: message, failures: this.failures }
    }
    if (generation !== this.generation) return
    this.latest = sample
    this.emit('sample', sample)
    const interval = this.opts.intervalMs
    const delay = this.failures === 0 ? interval : Math.min(this.opts.maxIntervalMs ?? 15_000, interval * 2 ** Math.min(this.failures, 6))
    this.timer = setTimeout(() => void this.poll(generation), delay)
  }
}

/** The /health base for a serving line's host: a wildcard listens on loopback too. */
export function healthBase(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
  return `http://${h}:${port}`
}
