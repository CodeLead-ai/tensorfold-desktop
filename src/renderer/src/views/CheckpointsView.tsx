import { useEffect, useState } from 'react'
import type { Checkpoint } from '@shared/checkpoints'
import { Icon } from '../components/Icon'
import { bytes, clock, int } from '../lib/format'
import { useDesk } from '../store'

/** SPEC §3.6 and §3.7: the checkpoint library, and pulling from Hugging Face. */
export function CheckpointsView(): React.JSX.Element {
  const scan = useDesk((s) => s.scan)
  const scanning = useDesk((s) => s.scanning)
  const { loadCheckpoints } = useDesk.getState()
  const [showSkipped, setShowSkipped] = useState(false)
  useEffect(() => {
    if (!useDesk.getState().scan) void loadCheckpoints(false)
  }, [loadCheckpoints])

  const servable = scan?.checkpoints.filter((c) => c.servable) ?? []
  const drafters = scan?.checkpoints.filter((c) => c.isDrafter) ?? []
  const skipped = scan?.checkpoints.filter((c) => !c.servable && !c.isDrafter) ?? []

  return (
    <div className="grid">
      <PullCard />
      <section className="card">
        <div className="card-head">
          <h2>Servable checkpoints</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {scan ? `${servable.length} of ${scan.checkpoints.length} folders · scanned ${clock(scan.at)}` : 'scanning…'}
          </span>
          <span className="spacer" />
          <button className="btn small" disabled={scanning} onClick={() => void loadCheckpoints(true)}>
            <Icon name="restart" size={13} /> {scanning ? 'Scanning…' : 'Scan again'}
          </button>
        </div>
        <div className="card-body">
          {scan?.error && <div className="issue error" style={{ marginBottom: 12 }}>{scan.error}</div>}
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            Folders:{' '}
            {scan?.roots.map((r) => (
              <span key={r.path} className="mono" style={{ marginRight: 12, color: r.exists ? undefined : 'var(--bad)' }} title={r.exists ? '' : 'not found'}>
                {r.path}
              </span>
            ))}
            <span className="faint">(Settings changes them)</span>
          </div>
          {scan && servable.length === 0 && <div className="empty">No servable checkpoint in these folders.</div>}
          <div className="cards">
            {servable.map((c) => (
              <CheckpointCard key={c.path} c={c} />
            ))}
          </div>
        </div>
      </section>

      {drafters.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Draft models in the Hugging Face cache</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              served next to their model (--drafter auto picks them)
            </span>
          </div>
          <div className="card-body">
            <table className="data plain">
              <tbody>
                {drafters.map((c) => (
                  <tr key={c.path}>
                    <td className="left">{c.repo}</td>
                    <td className="left faint">{c.sha?.slice(0, 12)}</td>
                    <td>{bytes(c.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <button className="section-toggle" onClick={() => setShowSkipped(!showSkipped)} aria-expanded={showSkipped}>
          <span style={{ display: 'inline-flex', transform: showSkipped ? 'rotate(90deg)' : 'none', color: 'var(--faint)' }}>
            <Icon name="chevron" size={14} />
          </span>
          Skipped
          <span className="note">GGUF folders, and checkpoints no TensorFold family runs</span>
          <span className="set">{skipped.length}</span>
        </button>
        {showSkipped && (
          <div className="card-body" style={{ paddingTop: 0 }}>
            <table className="data plain">
              <tbody>
                {skipped.map((c) => (
                  <tr key={c.path}>
                    <td className="left">{c.repo ?? c.path}</td>
                    <td className="left message muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {scan && (
        <section className="card">
          <div className="card-head">
            <h2>TensorFold's caches</h2>
          </div>
          <div className="card-body">
            <dl className="kv">
              {scan.caches.map((c) => (
                <FragmentRow key={c.path} k={c.path} v={`${bytes(c.bytes)} in ${int(c.files)} files`} />
              ))}
            </dl>
          </div>
        </section>
      )}
    </div>
  )
}

function FragmentRow({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <>
      <dt className="mono">{k}</dt>
      <dd>{v}</dd>
    </>
  )
}

function CheckpointCard({ c }: { c: Checkpoint }): React.JSX.Element {
  const serveThis = useDesk((s) => s.serveThis)
  const startPull = useDesk((s) => s.startPull)
  const pulling = useDesk((s) => s.pull?.status === 'running')
  const current = useDesk((s) => s.form.model === c.path)
  const info = c.info
  return (
    <article className={`ckpt ${current ? 'current' : ''}`}>
      <div className="ckpt-head">
        <div style={{ minWidth: 0 }}>
          <div className="ckpt-name" title={c.path}>
            {c.repo?.split('/').pop() ?? c.path.split('/').pop()}
          </div>
          <div className="ckpt-sub">{c.repo?.split('/')[0] ?? c.source}</div>
        </div>
        <button className={`btn small ${current ? '' : 'primary'}`} onClick={() => serveThis(c.path)} disabled={current}>
          {current ? 'In the form' : 'Serve this'}
        </button>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {info?.family && <span className="tag">{info.family}</span>}
        {c.testedFamily ? <span className="tag ok">tested family</span> : <span className="tag">untested family</span>}
        {c.testedCheckpoint && <span className="tag ok">tested checkpoint</span>}
        <span className="tag">{c.source === 'huggingface' ? 'Hugging Face' : c.source === 'lmstudio' ? 'LM Studio' : 'folder'}</span>
      </div>
      <dl className="kv small">
        <dt>quantization</dt>
        <dd>{info?.quantization ?? '–'}</dd>
        <dt>max context</dt>
        <dd>{int(info?.maxPositionEmbeddings)} tokens</dd>
        <dt>layers · hidden</dt>
        <dd>
          {int(info?.layers)} · {int(info?.hiddenSize)}
        </dd>
        <dt>on disk</dt>
        <dd>{bytes(c.sizeBytes)}</dd>
        <dt>drafter</dt>
        <dd>
          {c.drafter ? (
            c.drafter.pulled ? (
              <span className="ok">{c.drafter.repo} (pulled)</span>
            ) : (
              <span className="row wrap" style={{ gap: 6 }}>
                <span className="warn">{c.drafter.repo} not pulled</span>
                <button className="btn small" disabled={pulling} onClick={() => void startPull(c.drafter?.repo ?? '')}>
                  <Icon name="download" size={12} /> Pull
                </button>
              </span>
            )
          ) : (
            'none for this family'
          )}
        </dd>
        <dt>runs on</dt>
        <dd>{info?.runsOn ?? '–'}</dd>
      </dl>
    </article>
  )
}

function PullCard(): React.JSX.Element {
  const pull = useDesk((s) => s.pull)
  const scan = useDesk((s) => s.scan)
  const { startPull } = useDesk.getState()
  const [repo, setRepo] = useState('')
  const running = pull?.status === 'running'
  const pulled = new Set(scan?.checkpoints.map((c) => c.repo) ?? [])
  const offers = (scan?.families ?? [])
    .filter((f) => f.engines.some((e) => e.includes('MLX')))
    .flatMap((f) => f.drafters.map((d) => ({ repo: d, family: f.title })))
    .filter((d, i, all) => all.findIndex((x) => x.repo === d.repo) === i)

  return (
    <section className="card">
      <div className="card-head">
        <h2>Pull from Hugging Face</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          tensorfold pull downloads into the Hugging Face cache
        </span>
      </div>
      <div className="card-body grid" style={{ gap: 12 }}>
        <div className="row">
          <input className="input mono grow" placeholder="owner/name, e.g. Vontra/Qwen3.8-27B-MLX-4bit" value={repo} spellCheck={false} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && repo && void startPull(repo)} />
          <button className="btn primary" disabled={running || repo.trim() === ''} onClick={() => void startPull(repo)}>
            <Icon name="download" size={14} /> Pull
          </button>
          {running && (
            <button className="btn danger" onClick={() => void window.tfdesk.cancelPull()}>
              Cancel
            </button>
          )}
        </div>
        {offers.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Drafters of the tested families:
            </span>
            {offers.map((d) => (
              <button key={d.repo} className="btn small" disabled={running || pulled.has(d.repo)} onClick={() => void startPull(d.repo)} title={d.family}>
                {pulled.has(d.repo) ? '✓ ' : ''}
                {d.repo}
              </button>
            ))}
          </div>
        )}
        {pull && (
          <div className="pull-box">
            <div className="row">
              <span className={`tag ${pull.status === 'done' ? 'ok' : pull.status === 'failed' ? 'bad' : ''}`}>{pull.status}</span>
              <span className="mono">{pull.repo}</span>
              <span className="grow" />
              {pull.progress && (
                <span className="mono muted">
                  {pull.progress.label}: {pull.progress.done}/{pull.progress.total}
                </span>
              )}
            </div>
            <div className="progress">
              <i style={{ width: `${pull.status === 'done' ? 100 : (pull.progress?.percent ?? 0)}%` }} />
            </div>
            {pull.result && (
              <div className="mono" style={{ fontSize: 12 }}>
                {pull.result.gb} GB in {pull.result.path} <span className="muted">[{pull.result.what}]</span>
              </div>
            )}
            {pull.lines.length > 0 && <pre className="lines-box selectable" style={{ maxHeight: 140 }}>{pull.lines.slice(-12).join('\n')}</pre>}
          </div>
        )}
      </div>
    </section>
  )
}
