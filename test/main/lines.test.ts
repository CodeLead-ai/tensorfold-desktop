import { describe, expect, it } from 'vitest'
import { LineSplitter, lastSegment } from '../../src/main/lines'

describe('LineSplitter', () => {
  it('joins lines split across chunks and holds the unterminated rest', () => {
    const s = new LineSplitter()
    expect(s.push('[tensorfold] memory bud')).toEqual([])
    expect(s.push('get 44.8 GiB\n[tensorfold] load')).toEqual(['[tensorfold] memory budget 44.8 GiB'])
    expect(s.end()).toEqual(['[tensorfold] load'])
  })

  it('decodes a UTF-8 character split across two chunks', () => {
    const s = new LineSplitter()
    const bytes = Buffer.from('bar █ done\n', 'utf8')
    const cut = bytes.indexOf(0xe2) + 1
    expect(s.push(bytes.subarray(0, cut))).toEqual([])
    expect(s.push(bytes.subarray(cut))).toEqual(['bar █ done'])
  })

  it('drops CRLF endings and keeps the last state of a redrawn progress bar', () => {
    const s = new LineSplitter()
    expect(s.push('a\r\n\rFetching 6 files:  50%|█████     | 3/6\rFetching 6 files: 100%|██████████| 6/6\n')).toEqual([
      'a',
      'Fetching 6 files: 100%|██████████| 6/6'
    ])
    expect(lastSegment('\r\r')).toBe('')
  })
})
