import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEvent, drafterName, emptySessionInfo, lanesOf } from '@shared/session'
import { parseLine } from '../../src/main/LogParser'

const lines = readFileSync(join(__dirname, '..', 'fixtures', 'serve-log-2026-09-29.txt'), 'utf8').split('\n').filter(Boolean)

describe('session info from Appendix A', () => {
  const info = lines.map(parseLine).reduce(applyEvent, emptySessionInfo())

  it('knows the model, the endpoint and the budget', () => {
    expect(info.serving).toMatchObject({ model: 'Qwen3.8-27B-MLX-8bit', port: 8080, context: 89600, loadedInS: 31, drafts: true })
    expect(info.loading).toMatchObject({ family: 'Qwen3.8 dense', backend: 'mlx' })
    expect(info.memoryBudget?.budgetGib).toBe(44.8)
  })

  it('names the drafter and the lanes', () => {
    expect(drafterName(info)).toBe('z-lab/Qwen3.8-27B-DFlash2')
    expect(lanesOf(info)).toBe(8)
    expect(lanesOf(emptySessionInfo(), 4)).toBe(4)
  })

  it('counts requests and refusals, and keeps the last tok/s', () => {
    expect(info.done).toBe(2)
    expect(info.refused).toBe(1)
    expect(info.lastTokPerS).toBe(60.5)
  })

  it('returns the same object for events that change nothing', () => {
    const before = emptySessionInfo()
    expect(applyEvent(before, { kind: 'unknown', line: 'x' })).toBe(before)
  })
})
