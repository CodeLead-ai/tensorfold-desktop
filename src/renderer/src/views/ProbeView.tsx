import { useEffect, useState } from 'react'
import type { ReasoningEffort } from '@shared/config'
import type { ProbeResult } from '@shared/probe'
import { prefillRate } from '@shared/requests'
import type { ProbeSettings } from '@shared/settings'
import { Field, NumberInput, Segmented } from '../components/Fields'
import { Icon } from '../components/Icon'
import { clock, fixed, int } from '../lib/format'
import { useDesk } from '../store'

type Effort = ReasoningEffort | 'none'

/** SPEC §3.9: one chat completion, measured here and by the server, and the alternation set. */
export function ProbeView(): React.JSX.Element {
  const settings = useDesk((s) => s.settings)
  const status = useDesk((s) => s.server.status)
  const probes = useDesk((s) => s.probes)
  const probing = useDesk((s) => s.probing)
  const { runProbe, runAlternation, saveSettings } = useDesk.getState()
  const [probe, setProbe] = useState<ProbeSettings | null>(settings?.probe ?? null)
  useEffect(() => {
    if (settings && !probe) setProbe(settings.probe)
  }, [settings, probe])
  if (!probe) return <div className="empty">Loading…</div>

  const update = (patch: Partial<ProbeSettings>): void => {
    const next = { ...probe, ...patch }
    setProbe(next)
    void saveSettings({ probe: next })
  }
  const serving = status === 'serving'

  return (
    <div className="server-grid">
      <section className="card">
        <div className="card-head">
          <h2>Probe</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            a measuring tool, not a chat
          </span>
        </div>
        <div className="card-body grid" style={{ gap: 14 }}>
          <Field label={<span>Prompt</span>} wide>
            <textarea className="input mono" rows={5} value={probe.prompt} onChange={(e) => update({ prompt: e.target.value })} spellCheck={false} />
          </Field>
          <div className="fields" style={{ padding: 0 }}>
            <Field label={<code>max_tokens</code>}>
              <NumberInput value={probe.maxTokens} onChange={(v) => typeof v === 'number' && v >= 1 && update({ maxTokens: v })} />
            </Field>
            <Field label={<code>reasoning_effort</code>}>
              <Segmented<Effort>
                value={probe.reasoningEffort ?? 'none'}
                onChange={(v) => update({ reasoningEffort: v === 'none' ? null : v })}
                options={[
                  { value: 'none', label: 'server' },
                  { value: 'low', label: 'low' },
                  { value: 'medium', label: 'medium' },
                  { value: 'xhigh', label: 'xhigh' }
                ]}
              />
            </Field>
            <Field label={<code>stream</code>} help="Streaming gives the time to the first token.">
              <span className="row" style={{ height: 30 }}>
                <input type="checkbox" className="switch" checked={probe.stream} onChange={(e) => update({ stream: e.target.checked })} />
              </span>
            </Field>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!serving || probing !== null} onClick={() => void runProbe({ prompt: probe.prompt, maxTokens: probe.maxTokens, reasoningEffort: probe.reasoningEffort, stream: probe.stream, label: 'probe' })}>
              <Icon name="probe" size={14} /> {probing === 'probe' ? 'Running…' : 'Run the probe'}
            </button>
            {!serving && <span className="muted">Start the server first.</span>}
          </div>
          <div className="hr" />
          <div>
            <div className="kicker" style={{ marginBottom: 6 }}>
              Saved set: alternation
            </div>
            <p className="field-help" style={{ margin: '0 0 10px' }}>
              The bench's alternation probe: the prompt above alone, then a big generation, then the prompt again. It shows what a long reply leaves behind for the next request.
            </p>
            <Field label={<span>The big generation</span>} wide>
              <textarea className="input mono" rows={3} value={probe.bigPrompt} onChange={(e) => update({ bigPrompt: e.target.value })} spellCheck={false} />
            </Field>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted">its max_tokens</span>
              <div style={{ width: 120 }}>
                <NumberInput value={probe.bigMaxTokens} onChange={(v) => typeof v === 'number' && v >= 1 && update({ bigMaxTokens: v })} />
              </div>
              <span className="grow" />
              <button className="btn" disabled={!serving || probing !== null} onClick={() => void runAlternation()}>
                {probing?.startsWith('alternation') ? `Running ${probing.slice(12, 13)}/3…` : 'Run the alternation set'}
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="stack">
        {probes.length === 0 ? (
          <section className="card">
            <div className="empty">Results appear here: the app's own measurement beside the server's done line for the same request.</div>
          </section>
        ) : (
          probes.map((r, i) => <ResultCard key={`${r.startedAt}-${i}`} r={r} />)
        )}
      </div>
    </div>
  )
}

function ResultCard({ r }: { r: ProbeResult }): React.JSX.Element {
  const s = r.server
  return (
    <section className={`card ${r.ok ? '' : 'danger'}`}>
      <div className="card-head">
        <h2>{r.label}</h2>
        <span className="faint mono" style={{ fontSize: 11.5 }}>
          {clock(r.startedAt)} · {fixed(r.totalS, 2)} s
        </span>
        <span className="spacer" />
        {r.finish && <span className="tag">{r.finish}</span>}
      </div>
      <div className="card-body">
        {r.error && <div className="issue error selectable" style={{ marginBottom: 10 }}>{r.error}</div>}
        {r.ok && (
          <table className="data plain compare">
            <thead>
              <tr>
                <th className="left"></th>
                <th>measured here</th>
                <th>the server's done line</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="left">time to first token</td>
                <td>{r.ttftS === null ? 'not streamed' : `${fixed(r.ttftS, 2)} s`}</td>
                <td>{s?.ttftS === null || s === null ? '–' : `${fixed(s.ttftS, 2)} s`}</td>
              </tr>
              <tr>
                <td className="left">tok/s</td>
                <td>{fixed(r.tokPerS)}</td>
                <td>{fixed(s?.tokPerS)}</td>
              </tr>
              <tr>
                <td className="left">prompt · reply tokens</td>
                <td>
                  {int(r.promptTokens)} · {int(r.completionTokens)}
                </td>
                <td>{s ? `${int(s.prompt)} · ${int(s.tokens)}` : '–'}</td>
              </tr>
              <tr>
                <td className="left">cached · prefill</td>
                <td className="faint">–</td>
                <td>{s ? `${int(s.cached)} · ${fixed(s.prefillS, 2)} s (${int(prefillRate(s))} tok/s)` : '–'}</td>
              </tr>
              <tr>
                <td className="left">accepted drafts</td>
                <td className="faint">–</td>
                <td>{s ? `${int(s.accepted.accepted)}/${int(s.accepted.proposed)}` : '–'}</td>
              </tr>
              <tr>
                <td className="left">request</td>
                <td className="faint">–</td>
                <td className="selectable">{s?.reqId ?? 'no done line matched'}</td>
              </tr>
            </tbody>
          </table>
        )}
        {r.replyPreview && <pre className="lines-box selectable" style={{ marginTop: 10, whiteSpace: 'pre-wrap', maxHeight: 120 }}>{r.replyPreview}</pre>}
      </div>
    </section>
  )
}
