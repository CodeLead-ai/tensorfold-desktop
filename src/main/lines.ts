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

// Escape codes that start a line over (cursor to column 1, erase line, hide cursor before a spinner frame).
// eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const REDRAW = /\x1b\[\d*G|\x1b\[[012]?K|\x1b\[\?25l/g
// Every other terminal control sequence (CSI and OSC).
// eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * Command output as a person reads it: terminal escape codes removed, and a line redrawn in place (a spinner,
 * a progress bar) reduced to its last state.
 */
export function cleanTerminalOutput(text: string): string {
  return text
    .replace(REDRAW, '\r')
    .replace(CONTROL, '')
    .split('\n')
    .map(lastSegment)
    .join('\n')
}
