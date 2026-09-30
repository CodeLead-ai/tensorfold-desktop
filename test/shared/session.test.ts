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

describe("0.4.0+'s memory lines", () => {
  const T = (body: string) => parseLine(`[tensorfold] ${body}`)

  it('keeps the kept-prompt limit, the streams waiting for memory, and the requests memory ended', () => {
    const info = [
      T('requests up to 61,440 tokens keep their prompt for the next turn in the 44.8 GiB memory budget; a longer one is served, and its next turn prefills again'),
      T('memory: 2 of 5 streams wait for room (newest first)'),
      T('memory: ended req-0123456789ab, the newest of 5 streams')
    ].reduce(applyEvent, emptySessionInfo())
    expect(info.resumable).toEqual({ kind: 'startup', what: 'resumable', tokens: 61440, budgetGib: 44.8 })
    expect(info.memoryWait).toEqual({ waiting: 2, streams: 5 })
    expect(info.memoryEnded).toBe(1)
    expect(applyEvent(info, T('memory: 0 of 4 streams wait for room (newest first)')).memoryWait).toEqual({ waiting: 0, streams: 4 })
  })
})
