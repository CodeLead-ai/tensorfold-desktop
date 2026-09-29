import { describe, expect, it } from 'vitest'
import { GIB, gaugeOf, parseHealth, toGib } from '@shared/health'

/** SPEC Appendix A's /health sample. */
const SAMPLE = {
  status: 'ok',
  model: 'Qwen3.8-27B-MLX-8bit',
  model_ids: ['Qwen3.8-27B-MLX-8bit'],
  max_batch_size: 8,
  warming: false,
  memory: { active: 35826818500, cache: 8512000534, peak: 39936870996, budget: 48103633715, mlx_budget: 44882408243, footprint: 45436108856 }
}

describe('parseHealth', () => {
  it('reads the Appendix A sample field for field', () => {
    expect(parseHealth(SAMPLE)).toEqual(SAMPLE)
  })

  it('keeps a server that reports only active, cache and peak', () => {
    const health = parseHealth({ ...SAMPLE, memory: { active: 1, cache: 2, peak: 3 } })
    expect(health?.memory).toEqual({ active: 1, cache: 2, peak: 3 })
  })

  it('rejects what is not a health body', () => {
    expect(parseHealth(null)).toBeNull()
    expect(parseHealth('ok')).toBeNull()
    expect(parseHealth({ memory: {} })).toBeNull()
  })
})

describe('gauge', () => {
  it('converts bytes to GiB as the startup lines do', () => {
    expect(toGib(SAMPLE.memory.budget)).toBeCloseTo(44.8, 1)
    expect(toGib(SAMPLE.memory.mlx_budget)).toBeCloseTo(41.8, 1)
    expect(GIB).toBe(1073741824)
  })

  it('is active over mlx_budget, on the scale of the whole budget', () => {
    const g = gaugeOf(SAMPLE.memory)
    expect(g.scaleBytes).toBe(SAMPLE.memory.budget)
    expect(g.usedOfMlx).toBeCloseTo(35826818500 / 44882408243, 10)
    expect(g.activeFrac).toBeCloseTo(35826818500 / 48103633715, 10)
    expect(g.heldFrac).toBeCloseTo((35826818500 + 8512000534) / 48103633715, 10)
    expect(g.peakFrac).toBeCloseTo(39936870996 / 48103633715, 10)
    expect(g.mlxBudgetFrac).toBeCloseTo(44882408243 / 48103633715, 10)
  })

  it('clamps and falls back when the budget is unknown', () => {
    const g = gaugeOf({ active: 10, cache: 30, peak: 20 })
    expect(g.scaleBytes).toBe(40)
    expect(g.heldFrac).toBe(1)
    expect(g.mlxBudgetFrac).toBeNull()
    expect(g.usedOfMlx).toBeNull()
  })
})
