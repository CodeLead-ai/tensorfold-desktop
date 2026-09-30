import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LogLine, LogStream } from '@shared/events'
import { CopyButton } from '../components/CopyButton'
import { Icon } from '../components/Icon'
import { clock, int } from '../lib/format'
import { useDesk } from '../store'

const ROW = 20
const OVERSCAN = 20

/** The app's own /health polls, every 2 s: hidden unless asked for. */
function isHealthPoll(line: LogLine): boolean {
  return line.event.kind === 'access' && line.event.method === 'GET' && (line.event.path === '/health' || line.event.path.startsWith('/health?'))
}

export function LogView(): React.JSX.Element {
  const lines = useDesk((s) => s.lines)
  const logFile = useDesk((s) => s.server.logFile)
  const status = useDesk((s) => s.server.status)
  const armed = useDesk((s) => s.server.status === 'serving' || (s.server.status === 'loading' && s.server.info.memoryBudget !== null))
  const { dumpStacks } = useDesk.getState()
  const [query, setQuery] = useState('')
  const [streams, setStreams] = useState<Record<LogStream, boolean>>({ stdout: true, stderr: true, desk: true })
  const [showPolls, setShowPolls] = useState(false)
  const [follow, setFollow] = useState(true)
  const [selected, setSelected] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return lines.filter((l) => streams[l.stream] && (showPolls || !isHealthPoll(l)) && (q === '' || l.text.toLowerCase().includes(q)))
  }, [lines, query, streams, showPolls])

  useLayoutEffect(() => {
    const el = box.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [shown, follow])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewport({ top: el.scrollTop, height: el.clientHeight }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const first = Math.max(0, Math.floor(viewport.top / ROW) - OVERSCAN)
  const last = Math.min(shown.length, Math.ceil((viewport.top + viewport.height) / ROW) + OVERSCAN)
  const selectedLine = selected === null ? null : (lines.find((l) => l.seq === selected) ?? null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="log-toolbar">
        <div className="row" style={{ position: 'relative' }}>
          <input className="input" placeholder="Filter lines" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </div>
        {(['stdout', 'stderr', 'desk'] as const).map((s) => (
          <button key={s} className={`toggle-chip ${streams[s] ? 'on' : ''}`} onClick={() => setStreams({ ...streams, [s]: !streams[s] })}>
            {s === 'desk' ? 'app notes' : s}
          </button>
        ))}
        <button className={`toggle-chip ${showPolls ? 'on' : ''}`} onClick={() => setShowPolls(!showPolls)} title="The app reads GET /health every 2 s; each read is an access line">
          /health polls
        </button>
        <button className={`toggle-chip ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)}>
          follow
        </button>
        <span className="grow" />
        <span className="faint mono" style={{ fontSize: 12 }}>
          {int(shown.length)} of {int(lines.length)} lines
        </span>
        {(status === 'serving' || status === 'loading') && (
          <button className="btn small" disabled={!armed} onClick={() => void dumpStacks()} title="SIGUSR1: TensorFold prints every thread's Python stack on stderr, here">
            Dump stacks
          </button>
        )}
        <CopyButton text={() => shown.map((l) => l.text).join('\n')} label="Copy shown" />
        <CopyButton text={() => lines.map((l) => l.text).join('\n')} label="Copy all" />
        {logFile && (
          <button className="btn small" onClick={() => void window.tfdesk.reveal(logFile)} title={logFile}>
            <Icon name="folder" size={13} /> Log file
          </button>
        )}
      </div>
      <div
        className="log-box selectable"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          setViewport({ top: el.scrollTop, height: el.clientHeight })
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2
          if (follow && !atBottom) setFollow(false)
          if (!follow && atBottom) setFollow(true)
        }}
      >
        {shown.length === 0 ? (
          <div className="empty">{lines.length === 0 ? 'No output yet. Lines appear here as the server prints them.' : 'No line matches.'}</div>
        ) : (
          <div style={{ height: shown.length * ROW + 8, position: 'relative' }}>
            {shown.slice(first, last).map((line, i) => {
              const index = first + i
              const kind = line.stream === 'desk' ? '' : `k-${line.event.kind}`
              return (
                <div
                  key={line.seq}
                  className={`log-line s-${line.stream} ${kind} ${selected === line.seq ? 'selected' : ''}`}
                  style={{ top: index * ROW + 4 }}
                  onClick={() => setSelected(selected === line.seq ? null : line.seq)}
                >
                  <span className="ln">{line.seq}</span>
                  <span className="ts">{clock(line.at)}</span>
                  <span className="text">{line.stream === 'desk' ? `— ${line.text}` : line.text}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {selectedLine && (
        <div className="log-detail">
          <pre className="selectable">{selectedLine.text}</pre>
          <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <CopyButton text={selectedLine.text} label="Copy line" />
            <span className="tag" style={{ textAlign: 'center' }}>
              {selectedLine.stream} · {selectedLine.event.kind}
            </span>
          </div>
        </div>
      )}
      {!follow && shown.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn small" onClick={() => setFollow(true)}>
            Jump to the latest line
          </button>
        </div>
      )}
    </div>
  )
}
