import { useMemo, useState } from 'react'
import {
  FLAGS,
  GROUP_TITLES,
  PRESETS,
  applyPreset,
  buildServeArgv,
  buildServeEnv,
  presetOf,
  type GroupId,
  type ServeConfig
} from '@shared/config'
import type { SessionInfo } from '@shared/session'
import { drafterName } from '@shared/session'
import type { ValidationIssue } from '@shared/validate'
import { CopyButton } from '../components/CopyButton'
import { Field, FlagField, NumberInput, Segmented } from '../components/Fields'
import { Icon } from '../components/Icon'
import { MemoryGauge } from '../components/MemoryGauge'
import { clock, duration, fixed, int } from '../lib/format'
import { useNow } from '../lib/hooks'
import { useDesk } from '../store'

const GROUPS: GroupId[] = ['endpoint', 'generation', 'drafting', 'nvidia']

export function ServerView(): React.JSX.Element {
  return (
    <div className="server-grid">
      <ConfigCard />
      <div className="stack">
        <CommandCard />
        <ExitCard />
        <MemoryCard />
        <StartupCard />
      </div>
    </div>
  )
}

function useIssues(): Record<string, ValidationIssue> {
  const issues = useDesk((s) => s.issues)
  return useMemo(() => {
    const byField: Record<string, ValidationIssue> = {}
    for (const issue of issues) if (!byField[issue.field] || issue.severity === 'error') byField[issue.field] = issue
    return byField
  }, [issues])
}

function ConfigCard(): React.JSX.Element {
  const form = useDesk((s) => s.form)
  const setForm = useDesk((s) => s.setForm)
  const issues = useIssues()
  const [open, setOpen] = useState<Record<string, boolean>>({ endpoint: true, generation: true, drafting: true, env: false, nvidia: false })
  const preset = presetOf(form)

  const setFlag = (group: GroupId, key: string, value: unknown): void => {
    const next: ServeConfig = { ...form, [group]: { ...form[group] } }
    const target = next[group] as Record<string, unknown>
    if (value === undefined) delete target[key]
    else target[key] = value
    setForm(next)
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Configuration</h2>
        <span className="spacer" />
        <Segmented
          accent
          value={preset}
          onChange={(id) => id !== 'custom' && setForm(applyPreset(form, id))}
          options={[...PRESETS.map((p) => ({ value: p.id, label: p.name })), { value: 'custom' as const, label: 'Custom' }]}
        />
      </div>
      <div className="card-body" style={{ paddingBottom: 6 }}>
        <Field
          wide
          label={<span>Model</span>}
          issue={issues['model']}
          help="A model folder (LM Studio's MLX checkpoints work as folders) or a Hugging Face repo id"
        >
          <div className="row">
            <input className={`input mono grow ${issues['model']?.severity === 'error' ? 'invalid' : ''}`} value={form.model} spellCheck={false} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            <button
              type="button"
              className="btn"
              onClick={async (e) => {
                e.preventDefault()
                const dir = await window.tfdesk.chooseFile({ title: 'Choose a model folder', directory: true, defaultPath: form.model || undefined })
                if (dir) setForm({ ...form, model: dir })
              }}
            >
              <Icon name="folder" size={14} /> Choose…
            </button>
          </div>
        </Field>
        <p className="field-help" style={{ margin: '10px 0 2px' }}>
          {PRESETS.find((p) => p.id === preset)?.description ?? 'Custom: the flags below as set. Unset flags are not passed, so TensorFold applies its defaults.'}
        </p>
      </div>
      {GROUPS.slice(0, 3).map((group) => (
        <Section key={group} id={group} title={GROUP_TITLES[group]} open={open[group] ?? false} onToggle={() => setOpen({ ...open, [group]: !open[group] })} count={Object.values(form[group]).filter((v) => v !== undefined).length}>
          {FLAGS.filter((f) => f.group === group).map((spec) => (
            <FlagField key={spec.cli} spec={spec} value={(form[group] as Record<string, unknown>)[spec.key]} issue={issues[`${group}.${String(spec.key)}`]} onChange={(v) => setFlag(group, String(spec.key), v)} />
          ))}
        </Section>
      ))}
      <Section id="env" title="Environment" open={open['env'] ?? false} onToggle={() => setOpen({ ...open, env: !open['env'] })} count={form.env.memoryLimitGb === undefined ? 0 : 1}>
        <Field
          wide
          label={<code>TENSORFOLD_MEMORY_LIMIT_GB</code>}
          help="Raises the memory budget, up to the ceiling the startup line states (51.8 on a 64 GB Mac)"
          issue={issues['env.memoryLimitGb']}
          set={form.env.memoryLimitGb !== undefined}
          onClear={() => setForm({ ...form, env: {} })}
        >
          <NumberInput
            value={form.env.memoryLimitGb}
            placeholder="default: 70% of RAM"
            onChange={(v) => setForm({ ...form, env: typeof v === 'number' ? { memoryLimitGb: v } : {} })}
          />
        </Field>
      </Section>
      <Section id="nvidia" title={GROUP_TITLES.nvidia} note="shown for reference; they do nothing on a Mac" open={open['nvidia'] ?? false} onToggle={() => setOpen({ ...open, nvidia: !open['nvidia'] })} count={Object.values(form.nvidia).filter((v) => v !== undefined).length}>
        {FLAGS.filter((f) => f.group === 'nvidia').map((spec) => (
          <FlagField key={spec.cli} spec={spec} value={(form.nvidia as Record<string, unknown>)[spec.key]} issue={issues[`nvidia.${String(spec.key)}`]} onChange={(v) => setFlag('nvidia', String(spec.key), v)} />
        ))}
      </Section>
    </section>
  )
}

function Section({ id, title, note, open, onToggle, count, children }: { id: string; title: string; note?: string; open: boolean; onToggle: () => void; count: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="form-section" data-section={id}>
      <button type="button" className="section-toggle" onClick={onToggle} aria-expanded={open}>
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', color: 'var(--faint)' }}>
          <Icon name="chevron" size={14} />
        </span>
        {title}
        {note && <span className="note">{note}</span>}
        {count > 0 && <span className="set">{count} set</span>}
      </button>
      {open && <div className="fields">{children}</div>}
    </div>
  )
}

function Command({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(\s--[a-z][a-z0-9-]*)/g)
  const first = parts[0] ?? ''
  const serveAt = first.search(/\sserve\s/)
  return (
    <pre className="command selectable">
      {serveAt > 0 ? (
        <>
          <span className="bin">{first.slice(0, serveAt)}</span>
          {first.slice(serveAt)}
        </>
      ) : (
        first
      )}
      {parts.slice(1).map((part, i) => (i % 2 === 0 ? <span key={i} className="flag">{part}</span> : <span key={i}>{part}</span>))}
    </pre>
  )
}

function CommandCard(): React.JSX.Element {
  const preview = useDesk((s) => s.preview)
  const issues = useDesk((s) => s.issues)
  const form = useDesk((s) => s.form)
  const server = useDesk((s) => s.server)
  const busy = useDesk((s) => s.busy)
  const binary = useDesk((s) => s.binary)
  const { start, stop, restart, kill, setView } = useDesk.getState()
  const errors = issues.filter((i) => i.severity === 'error')
  const running = server.status === 'loading' || server.status === 'serving'
  const differs =
    running && server.config !== null && JSON.stringify([buildServeArgv(form), buildServeEnv(form)]) !== JSON.stringify([server.argv, buildServeEnv(server.config)])

  return (
    <section className="card">
      <div className="card-head">
        <h2>Command</h2>
        <span className="spacer" />
        <CopyButton text={preview} />
      </div>
      <div className="card-body">
        <Command text={preview || '…'} />
        {binary && !binary.path && (
          <div className="issue error" style={{ marginTop: 10 }}>
            <Icon name="alert" size={14} />
            <span>
              {binary.error}{' '}
              <button className="btn small" onClick={() => setView('settings')}>
                Settings
              </button>
            </span>
          </div>
        )}
        {issues.length > 0 && (
          <div className="issues">
            {issues.map((issue, i) => (
              <div key={i} className={`issue ${issue.severity}`}>
                <code>{issue.field}</code>
                <span>{issue.message}</span>
              </div>
            ))}
          </div>
        )}
        {differs && <div className="field-help" style={{ marginTop: 10 }}>The form differs from the running server; Restart applies it.</div>}
        <div className="row" style={{ marginTop: 14 }}>
          {server.status === 'stopped' && (
            <button className="btn primary" disabled={busy || errors.length > 0} onClick={() => void start()}>
              <Icon name="play" size={14} filled /> Start
            </button>
          )}
          {running && (
            <>
              <button className="btn danger" onClick={() => void stop()}>
                <Icon name="stop" size={13} filled /> Stop
              </button>
              <button className="btn" disabled={busy || errors.length > 0} onClick={() => void restart()}>
                <Icon name="restart" size={14} /> Restart{differs ? ' with changes' : ''}
              </button>
            </>
          )}
          {server.status === 'stopping' && (
            <button className="btn danger" onClick={() => void kill()}>
              <Icon name="kill" size={14} /> Force stop
            </button>
          )}
          <span className="spacer grow" />
          {server.logFile && (
            <button className="btn ghost small" onClick={() => void window.tfdesk.reveal(server.logFile as string)} title={server.logFile}>
              <Icon name="folder" size={13} /> Log file
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function MemoryCard(): React.JSX.Element | null {
  const server = useDesk((s) => s.server)
  const health = useDesk((s) => s.health)
  if (server.status === 'stopped') return null
  return (
    <section className="card">
      <div className="card-head">
        <h2>Memory</h2>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11.5 }}>
          GET /health · every 2 s{health ? ` · ${clock(health.at)}` : ''}
        </span>
      </div>
      <div className="card-body">
        <MemoryGauge sample={health} budgetLine={server.info.memoryBudget} serving={server.status === 'serving'} />
      </div>
    </section>
  )
}

function steps(info: SessionInfo): Array<{ what: string; value: string }> {
  const out: Array<{ what: string; value: string }> = []
  if (info.memoryBudget) out.push({ what: 'memory budget', value: `${info.memoryBudget.budgetGib} GiB (MLX ${info.memoryBudget.mlxGib} GiB)` })
  if (info.loading) out.push({ what: 'loading', value: `${info.loading.family} (${info.loading.modelType})` })
  if (info.laneKernels) out.push({ what: 'lane kernels', value: `${info.laneKernels.shapesWarmed} shapes warmed` })
  if (info.drafter) out.push({ what: 'drafter', value: `${drafterName(info)} · block ${info.drafter.block} · ${info.drafter.bits}-bit` })
  if (info.noDrafter) out.push({ what: 'no drafter', value: `pull ${info.noDrafter.repo} to draft` })
  if (info.laneWindows) out.push({ what: 'exact windows', value: `up to ${info.laneWindows.exactRows} rows` })
  if (info.weights) out.push({ what: 'weights', value: `${info.weights.residentGib} GiB resident${info.weights.fileBackedGib ? `, ${info.weights.fileBackedGib} GiB file-backed` : ''}` })
  if (info.promptChunks) out.push({ what: 'prompt chunks', value: `${int(info.promptChunks.chunkTokens)} tokens` })
  if (info.concurrency) {
    const c = info.concurrency
    out.push({ what: 'concurrency', value: `${c.lanes} lanes · ${c.budgetGb} GB for streams${c.fits ? ` · ${c.fits.streams} × ${int(c.fits.tokens)} tokens fit now` : ''}` })
  }
  if (info.contextWindow) out.push({ what: 'context window', value: `${int(info.contextWindow.tokens)} tokens (fitted)` })
  if (info.serving) out.push({ what: 'serving', value: `${info.serving.url} · loaded in ${fixed(info.serving.loadedInS)} s` })
  for (const note of info.notes) out.push({ what: 'note', value: note })
  return out
}

function StartupCard(): React.JSX.Element | null {
  const server = useDesk((s) => s.server)
  const now = useNow(500)
  if (server.status === 'stopped') return null
  const list = steps(server.info)
  return (
    <section className="card">
      <div className="card-head">
        <h2>Startup</h2>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11.5 }}>
          {server.status === 'loading' ? `loading for ${duration(now - (server.startedAt ?? now))}` : server.info.serving ? `loaded in ${fixed(server.info.serving.loadedInS)} s` : ''}
        </span>
      </div>
      <div className="card-body">
        {list.length === 0 ? (
          <div className="muted">Waiting for the first line…</div>
        ) : (
          <ul className="steps">
            {list.map((s, i) => (
              <li key={i}>
                <span className="tick">✓</span>
                <span>
                  <span className="what">{s.what}</span> <b>{s.value}</b>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function ExitCard(): React.JSX.Element | null {
  const server = useDesk((s) => s.server)
  const exit = server.lastExit
  if (server.status !== 'stopped' || !exit || exit.requested) return null
  const how = exit.spawnError ? `could not start: ${exit.spawnError}` : exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`
  return (
    <section className="card danger">
      <div className="card-head">
        <Icon name="alert" size={15} />
        <h2 className="bad">The server died {exit.during === 'loading' ? 'while loading' : exit.during === 'serving' ? 'while serving' : ''}</h2>
        <span className="spacer" />
        <span className="mono bad">{how}</span>
      </div>
      <div className="card-body">
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="muted">Last {exit.lastLines.length} lines, stderr in red · {new Date(exit.at).toLocaleTimeString()}</span>
          <span className="grow" />
          <CopyButton text={exit.lastLines.map((l) => l.text).join('\n')} />
          {server.logFile && (
            <button className="btn small" onClick={() => void window.tfdesk.reveal(server.logFile as string)}>
              <Icon name="folder" size={13} /> Log file
            </button>
          )}
        </div>
        <pre className="lines-box selectable">
          {exit.lastLines.length === 0
            ? '(no output)'
            : exit.lastLines.map((l) => (
                <div key={l.seq} className={l.stream === 'stderr' ? 'stderr' : ''}>
                  {l.text}
                </div>
              ))}
        </pre>
      </div>
    </section>
  )
}
