import { StringDecoder } from 'node:string_decoder'

/**
 * Splits a child's byte stream into UTF-8 lines. A line redrawn with carriage returns (a progress bar)
 * yields its last state; a CRLF ending is dropped.
 */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private partial = ''

  push(chunk: Buffer | string): string[] {
    this.partial += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const parts = this.partial.split('\n')
    this.partial = parts.pop() ?? ''
    return parts.map(lastSegment)
  }

  /** The unterminated rest, when the stream ends. */
  end(): string[] {
    this.partial += this.decoder.end()
    const rest = this.partial
    this.partial = ''
    return rest === '' ? [] : [lastSegment(rest)]
  }
}

export function lastSegment(line: string): string {
  const body = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!body.includes('\r')) return body
  const segments = body.split('\r').filter((s) => s !== '')
  return segments[segments.length - 1] ?? ''
}
