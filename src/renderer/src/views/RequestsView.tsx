import { useMemo, useRef, useState } from 'react'
import { acceptanceRatio, overKept, prefillRate, summarize, tokPerSSeries, type RequestRow } from '@shared/requests'
import { CopyButton } from '../components/CopyButton'
import { Segmented } from '../components/Fields'
import { Sparkline } from '../components/Sparkline'
import { clock, compact, fixed, int, percent } from '../lib/format'
import { useDesk } from '../store'

const SHOWN = 2000

type Filter = 'all' | 'done' | 'refused'

export function RequestsView(): React.JSX.Element {
  const rows = useDesk((s) => s.rows)
  const status = useDesk((s) => s.server.status)
  const kept = useDesk((s) => s.server.info.resumable?.tokens ?? null)
  const totals = useMemo(() => summarize(rows), [rows])
  const series = useMemo(() => tokPerSSeries(rows, 60), [rows])
  const [filter, setFilter] = useState<Filter>('all')
  const mountedAt = useRef(Date.now())
  const visible = useMemo(() => {
    const kept = rows.filter((r) => filter === 'all' || (filter === 'done' ? r.kind === 'done' : r.kind !== 'done'))
    return kept.slice(-SHOWN).reverse()
  }, [rows, filter])
  const cache = totals.cache
  const min = series.length ? Math.min(...series) : null
  const max = series.length ? Math.max(...series) : null

  return (
    <div className="grid">
      <div className="tiles">
        <Tile
          label="Requests"
          value={int(totals.requests)}
          sub={`${totals.refused} refused · ${totals.failed} failed`}
          hint={totals.ended ? `${totals.failed} failed, ${totals.ended} of them ended when memory ran short` : undefined}
          bad={totals.refused + totals.failed > 0}
        />
        <Tile label="Tokens in" value={compact(totals.tokensIn)} sub={`${compact(totals.cachedIn)} cached`} />
        <Tile label="Tokens out" value={compact(totals.tokensOut)} sub="thinking included" />
        <Tile label="Mean tok/s" value={fixed(totals.meanTokPerS)} sub={`weighted ${fixed(totals.weightedTokPerS)}`} />
        <Tile label="Prefill" value={totals.prefillRate === null ? '–' : `${int(totals.prefillRate)}`} sub="tok/s, uncached tokens" />
        <Tile label="Acceptance" value={percent(totals.acceptance)} sub="of proposed drafts" />
        <Tile label="Prefix cache" value={cache ? `${cache.hits}/${cache.misses}/${cache.evictions}` : '–'} sub={cache ? `h/m/e · ${cache.count} kept · ${cache.gib.toFixed(2)} GiB` : 'hits/misses/evictions'} />
      </div>

      <section className="card spark-card">
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="kicker">tok/s, last {series.length || 60} requests</span>
          </div>
          <Sparkline values={series} height={70} />
        </div>
        <div className="spark-stats">
          <span>
            last <b>{fixed(totals.lastTokPerS)}</b>
          </span>
          <span className="mono">
            min {fixed(min)} · max {fixed(max)}
          </span>
          <span className="mono faint">dashed: the mean</span>
        </div>
      </section>

      <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 360 }}>
        <div className="card-head">
          <h2>Request feed</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            parsed from the server's stdout{rows.length > SHOWN ? ` · newest ${int(SHOWN)} of ${int(rows.length)}` : ''}
            {kept !== null && (
              <span title="TensorFold keeps a request's prompt for its next turn up to this many tokens, prompt and reply; past it the request is served, and its next turn prefills again">
                {' '}
                · prompts kept up to {int(kept)} tokens
              </span>
            )}
          </span>
          <span className="spacer" />
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'done', label: 'Done' },
              { value: 'refused', label: `Refused${totals.refused + totals.failed ? ` (${totals.refused + totals.failed})` : ''}` }
            ]}
          />
        </div>
        {visible.length === 0 ? (
          <div className="empty">{status === 'serving' ? 'Waiting for the first request. Each done line appears here as it is printed.' : 'No requests in this session yet.'}</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 430px)', minHeight: 260 }}>
            <table className="data">
              <thead>
                <tr>
                  <th className="left">time</th>
                  <th className="left">request</th>
                  <th>prompt</th>
                  <th>cached</th>
                  <th className="left">effort</th>
                  <th className="left">think</th>
                  <th>reply</th>
                  <th className="left">finish</th>
                  <th>tok/s</th>
                  <th>ttft</th>
                  <th>prefill</th>
                  <th>prefill tok/s</th>
                  <th>accepted</th>
                  <th>ms/round</th>
                  <th title="the server's running totals">cache h/m/e</th>
                  <th className="left">sha</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <Row key={row.seq} row={row} fresh={row.at > mountedAt.current} kept={kept} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Tile({ label, value, sub, hint, bad }: { label: string; value: string; sub: string; hint?: string; bad?: boolean }): React.JSX.Element {
  return (
    <div className="tile" title={hint}>
      <span className="label">{label}</span>
      <span className={`value ${bad ? 'bad' : ''}`}>{value}</span>
      <span className="sub" title={hint ?? sub}>
        {sub}
      </span>
    </div>
  )
}

function Row({ row, fresh, kept }: { row: RequestRow; fresh: boolean; kept: number | null }): React.JSX.Element {
  const cls = fresh ? 'fresh' : ''
  if (row.kind === 'done') {
    const e = row.event
    const ratio = acceptanceRatio(e)
    const over = overKept(e, kept)
    return (
      <tr className={cls}>
        <td className="left faint">{clock(row.at)}</td>
        <td className="left selectable">{e.reqId}</td>
        <td className={over ? 'warn' : ''} title={over ? `${int(e.prompt + e.tokens)} tokens with the reply: past the ${int(kept)} whose prompt is kept, so this conversation's next turn prefills again` : undefined}>
          {over && <span className="over-kept">↻ </span>}
          {int(e.prompt)}
        </td>
        <td className={e.cached > 0 ? 'ok' : 'faint'}>{int(e.cached)}</td>
        <td className="left">{e.effort ?? '–'}</td>
        <td className="left">{e.thinking === null ? '–' : e.thinking ? 'yes' : 'no'}</td>
        <td>{int(e.tokens)}</td>
        <td className="left">
          <span className={`tag ${e.finish === 'stop' ? 'ok' : ''}`}>{e.finish}</span>
        </td>
        <td style={{ fontWeight: 600 }}>{fixed(e.tokPerS)}</td>
        <td>{fixed(e.ttftS, 2)}</td>
        <td>{fixed(e.prefillS, 2)}</td>
        <td>{int(prefillRate(e))}</td>
        <td title={ratio === null ? '' : percent(ratio)}>
          {int(e.accepted.accepted)}/{int(e.accepted.proposed)}
          <span className="ratio">
            <i style={{ width: `${(ratio ?? 0) * 100}%` }} />
          </span>
        </td>
        <td>{fixed(e.msPerRound)}</td>
        <td className="faint">{e.checkpoints ? `${e.checkpoints.hits}/${e.checkpoints.misses}/${e.checkpoints.evictions}` : 'off'}</td>
        <td className="left faint selectable">{e.sha}</td>
      </tr>
    )
  }
  if (row.kind === 'refused') {
    const e = row.event
    const facts = [
      e.replyTokens !== null ? `the client asked ${int(e.replyTokens)} reply tokens` : null,
      e.needGib !== null ? `needs ${e.needGib} of ${e.ofGib} GiB` : null,
      e.promptFitTokens !== null ? `fits ${int(e.promptFitTokens)} prompt tokens` : null
    ].filter(Boolean)
    return (
      <tr className={`refused ${cls}`}>
        <td className="left">{clock(row.at)}</td>
        <td className="left selectable">{e.reqId}</td>
        <td colSpan={14} className="message">
          <div className="msg">
          <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
            <span className="tag bad">refused before prefill</span>
            {facts.map((f) => (
              <span key={f} className="tag bad">
                {f}
              </span>
            ))}
            <span className="grow" />
            <CopyButton text={e.message} label="Copy message" />
          </div>
          <span className="selectable">
            {e.errorType ? `${e.errorType}: ` : ''}
            {e.message}
          </span>
          </div>
        </td>
      </tr>
    )
  }
  if (row.kind === 'http') {
    return (
      <tr className={`refused ${cls}`}>
        <td className="left">{clock(row.at)}</td>
        <td className="left">HTTP {row.status}</td>
        <td colSpan={14} className="message">
          <span className="tag bad">{row.status === 400 ? 'refused' : 'failed'}</span>{' '}
          {row.method} {row.path} answered {row.status}
          {row.status === 400 ? ': the window check refused it before admission; the message went to the client (the log does not keep it).' : '.'}
        </td>
      </tr>
    )
  }
  if (row.kind === 'ended') {
    return (
      <tr className={`refused ${cls}`}>
        <td className="left">{clock(row.at)}</td>
        <td className="left selectable">{row.reqId}</td>
        <td colSpan={14} className="message">
          <span className="tag bad">ended for memory</span> the newest of {row.streams} streams when memory ran short, stopped mid-reply so the older ones could finish. The client got an error: retry it, shorten the
          prompt or max_tokens, or serve with a smaller --parallel.
        </td>
      </tr>
    )
  }
  return (
    <tr className={`refused ${cls}`}>
      <td className="left">{clock(row.at)}</td>
      <td className="left">{row.what} error</td>
      <td colSpan={14} className="message selectable">
        {row.errorType ? `${row.errorType}: ` : ''}
        {row.message}
      </td>
    </tr>
  )
}
