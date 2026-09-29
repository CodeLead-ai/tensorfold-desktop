/**
 * `GET /health` (SPEC §2.2): the only live metrics endpoint. Memory values are bytes. `budget`,
 * `mlx_budget` and `footprint` come from the MLX server's admission; a server without it reports only
 * active, cache and peak, and the CUDA server reports none.
 */

export interface HealthMemory {
  /** MLX's live buffers: weights, KV and caches in use. */
  active: number
  /** MLX's cache of freed buffers kept for reuse. */
  cache: number
  /** The highest `active` since the server started (or the last reset_peak). */
  peak: number
  /** The server's memory budget (the startup line's "memory budget N GiB"). */
  budget?: number
  /** What MLX may use: the budget less the process's share. */
  mlx_budget?: number
  /** The process's physical footprint. */
  footprint?: number
}

export interface Health {
  status: string
  model: string
  model_ids: string[]
  max_batch_size: number
  warming: boolean
  memory: HealthMemory
}

export type HealthSample =
  | { at: number; ok: true; health: Health }
  | { at: number; ok: false; error: string; failures: number }

export const GIB = 1024 ** 3

export function toGib(bytes: number): number {
  return bytes / GIB
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A /health body, checked; null when it is not one. */
export function parseHealth(body: unknown): Health | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const m = (typeof b['memory'] === 'object' && b['memory'] !== null ? b['memory'] : {}) as Record<string, unknown>
  const memory: HealthMemory = { active: num(m['active']) ?? 0, cache: num(m['cache']) ?? 0, peak: num(m['peak']) ?? 0 }
  for (const key of ['budget', 'mlx_budget', 'footprint'] as const) {
    const value = num(m[key])
    if (value !== undefined) memory[key] = value
  }
  if (typeof b['status'] !== 'string') return null
  return {
    status: b['status'],
    model: typeof b['model'] === 'string' ? b['model'] : '',
    model_ids: Array.isArray(b['model_ids']) ? b['model_ids'].filter((x): x is string => typeof x === 'string') : [],
    max_batch_size: num(b['max_batch_size']) ?? 0,
    warming: b['warming'] === true,
    memory
  }
}

export interface Gauge {
  /** The scale: the budget when known, else mlx_budget, else peak. */
  scaleBytes: number
  activeFrac: number
  /** active + cache, the MLX memory held. */
  heldFrac: number
  peakFrac: number
  /** Where mlx_budget falls on the scale; null when unknown. */
  mlxBudgetFrac: number | null
  /** active over mlx_budget (SPEC §2.4); null when mlx_budget is unknown. */
  usedOfMlx: number | null
}

/** SPEC §2.4: the gauge is active over mlx_budget, with cache and peak as marks, on a scale of the whole budget. */
export function gaugeOf(memory: HealthMemory): Gauge {
  const scaleBytes = memory.budget ?? memory.mlx_budget ?? Math.max(memory.peak, memory.active + memory.cache, 1)
  const frac = (bytes: number): number => Math.min(1, Math.max(0, bytes / scaleBytes))
  return {
    scaleBytes,
    activeFrac: frac(memory.active),
    heldFrac: frac(memory.active + memory.cache),
    peakFrac: frac(memory.peak),
    mlxBudgetFrac: memory.mlx_budget === undefined ? null : frac(memory.mlx_budget),
    usedOfMlx: memory.mlx_budget ? memory.active / memory.mlx_budget : null
  }
}
