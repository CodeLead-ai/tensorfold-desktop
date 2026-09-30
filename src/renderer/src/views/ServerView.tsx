import { useEffect, useMemo, useState } from 'react'
import type { SnapshotResult } from '@shared/api'
import {
  FLAGS,
  GROUP_TITLES,
  PRESETS,
  applyPreset,
  buildServeArgv,
  buildServeEnv,
  presetOf,
  type ExtraFlags,
  type FlagSpec,
  type GroupId,
  type ServeConfig
} from '@shared/config'
import { helpSwitches, unknownFlags, type HelpFlag } from '@shared/serveHelp'
import type { SessionInfo } from '@shared/session'
import { drafterName } from '@shared/session'
import { notInBinary, type ValidationIssue } from '@shared/validate'
import { CopyButton } from '../components/CopyButton'
import { ExtraField, Field, FlagField, NumberInput, Segmented } from '../components/Fields'
import { Icon } from '../components/Icon'
import { MemoryGauge } from '../components/MemoryGauge'
import { bytes, clock, duration, fixed, int } from '../lib/format'
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
        <SnapshotCard />
        <LmStudioCard />
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

/** The form's value for a flag the app's table lacks: the text, or `on` / `off` for a switch. */
function extraValue(extra: ExtraFlags | undefined, flag: HelpFlag): string | 'on' | 'off' | undefined {
  const value = extra?.[flag.cli]
  if (value === true) return 'on'
  if (flag.negative && extra?.[flag.negative] === true) return 'off'
  return typeof value === 'string' ? value : undefined
}

function ConfigCard(): React.JSX.Element {
  const form = useDesk((s) => s.form)
  const setForm = useDesk((s) => s.setForm)
  const binary = useDesk((s) => s.binary)
  const issues = useIssues()
  const [open, setOpen] = useState<Record<string, boolean>>({ endpoint: true, generation: true, drafting: true, env: false, nvidia: false, extra: true })
  const preset = presetOf(form)
  const help = binary?.serveHelp ?? null
  const switches = useMemo(() => (help ? helpSwitches(help) : null), [help])
  const others = useMemo(() => (help ? unknownFlags(help) : []), [help])
  // Extra flags set in the form that this binary does not list (it was downgraded, or the form came from elsewhere).
  const strays = Object.keys(form.extra ?? {}).filter((cli) => !others.some((o) => o.cli === cli || o.negative === cli))
  const missing = (spec: FlagSpec): string | undefined =>
    switches && !switches.has(spec.cli) ? notInBinary(spec.cli, { version: binary?.version ?? null, switches }, spec.since) : undefined

  const setFlag = (group: GroupId, key: string, value: unknown): void => {
    const next: ServeConfig = { ...form, [group]: { ...form[group] } }
    const target = next[group] as Record<string, unknown>
    if (value === undefined) delete target[key]
    else target[key] = value
    setForm(next)
  }

  const setExtra = (flag: { cli: string; negative: string | null }, value: string | 'on' | 'off' | undefined): void => {
    const extra: ExtraFlags = { ...(form.extra ?? {}) }
    delete extra[flag.cli]
    if (flag.negative) delete extra[flag.negative]
    if (value === 'on') extra[flag.cli] = true
    else if (value === 'off' && flag.negative) extra[flag.negative] = true
    else if (value !== undefined && value !== '') extra[flag.cli] = value
    const { extra: _old, ...rest } = form
    setForm(Object.keys(extra).length > 0 ? { ...rest, extra } : rest)
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
            <FlagField
              key={spec.cli}
              spec={spec}
              value={(form[group] as Record<string, unknown>)[spec.key]}
              issue={issues[`${group}.${String(spec.key)}`]}
              missing={missing(spec)}
              onChange={(v) => setFlag(group, String(spec.key), v)}
            />
          ))}
        </Section>
      ))}
      {(others.length > 0 || strays.length > 0) && (
        <Section
          id="extra"
          title="More flags"
          note={`listed by tensorfold ${binary?.version ?? ''} and new to this app: passed as set`}
          open={open['extra'] ?? true}
          onToggle={() => setOpen({ ...open, extra: !open['extra'] })}
          count={Object.keys(form.extra ?? {}).length}
        >
          {others.map((flag) => (
            <ExtraField key={flag.cli} flag={flag} value={extraValue(form.extra, flag)} issue={issues[`extra.${flag.cli}`] ?? (flag.negative ? issues[`extra.${flag.negative}`] : undefined)} onChange={(v) => setExtra(flag, v)} />
          ))}
          {strays.map((cli) => (
            <ExtraField
              key={cli}
              flag={{ cli, negative: null, metavar: form.extra?.[cli] === true ? null : 'VALUE', choices: null, help: 'set in this form, but not listed by the installed TensorFold', defaultText: null, group: '' }}
              value={form.extra?.[cli] === true ? 'on' : (form.extra?.[cli] as string | undefined)}
              issue={issues[`extra.${cli}`]}
              onChange={(v) => setExtra({ cli, negative: null }, v)}
            />
          ))}
        </Section>
      )}
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
          <FlagField
            key={spec.cli}
            spec={spec}
            value={(form.nvidia as Record<string, unknown>)[spec.key]}
            issue={issues[`nvidia.${String(spec.key)}`]}
            missing={missing(spec)}
            onChange={(v) => setFlag('nvidia', String(spec.key), v)}
          />
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
  const { start, stop, restart, kill, setView, dumpStacks } = useDesk.getState()
  const errors = issues.filter((i) => i.severity === 'error')
  const running = server.status === 'loading' || server.status === 'serving'
  // TensorFold arms its stack dump just before the memory budget line; SIGUSR1 before then would end it.
  const dumpable = server.status === 'serving' || (server.status === 'loading' && server.info.memoryBudget !== null)
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
          {running && (
            <button
              className="btn ghost small"
              disabled={!dumpable}
              onClick={() => void dumpStacks()}
              title="SIGUSR1: TensorFold prints every thread's Python stack on stderr, in the Log view. For a server that seems stuck."
            >
              <Icon name="log" size={13} /> Dump stacks
            </button>
          )}
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
  if (info.contextWindow) {
    out.push({ what: 'context window', value: `${int(info.contextWindow.tokens)} tokens (fitted${info.contextWindow.keepsPrompt ? '; each request keeps its prompt for the next turn' : ''})` })
  }
  if (info.resumable) {
    out.push({ what: 'prompts kept', value: `up to ${int(info.resumable.tokens)} tokens with the reply; a longer request's next turn prefills again` })
  }
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

/** SPEC §2.5 and §3.8: what LM Studio has loaded, and the two ways around it. */
function LmStudioCard(): React.JSX.Element | null {
  const lms = useDesk((s) => s.lms)
  const busy = useDesk((s) => s.lmsBusy)
  const steps = useDesk((s) => s.lastSteps)
  const status = useDesk((s) => s.server.status)
  const settings = useDesk((s) => s.settings)
  const { refreshLms, unloadAndServe, stopAndRestore, setView } = useDesk.getState()
  useEffect(() => {
    void refreshLms()
    // LM Studio may have started or quit meanwhile; look again when the window comes back (no polling).
    const onFocus = (): void => void refreshLms()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshLms])
  const generating = lms?.models.filter((m) => m.status === 'generating') ?? []
  const restore = settings?.restoreCommand.trim() ?? ''
  if (!lms?.running) return null

  return (
    <section className="card">
      <div className="card-head">
        <h2>LM Studio</h2>
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => void refreshLms()}>
          <Icon name="restart" size={12} /> Check
        </button>
      </div>
      <div className="card-body grid" style={{ gap: 12 }}>
        <span className="field-help">Its loaded models count against TensorFold's memory budget: unload them before serving.</span>
        {!lms.available ? (
          <div className="issue warning">
            <Icon name="alert" size={14} />
            <span>
              {lms.error}{' '}
              <button className="btn small" onClick={() => setView('settings')}>
                Settings
              </button>
            </span>
          </div>
        ) : lms.models.length === 0 ? (
          <span className="muted">Nothing loaded in LM Studio.</span>
        ) : (
          <table className="data plain">
            <tbody>
              {lms.models.map((m) => (
                <tr key={m.identifier}>
                  <td className="left">{m.identifier}</td>
                  <td>{m.sizeBytes ? bytes(m.sizeBytes) : '–'}</td>
                  <td className="left">
                    <span className={`tag ${m.status === 'generating' ? 'bad' : ''}`}>{m.status ?? '?'}</span>
                  </td>
                  <td className="faint">ctx {int(m.contextLength)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row wrap">
          <button
            className="btn"
            disabled={busy || status !== 'stopped' || !lms.available}
            onClick={() => {
              if (generating.length && !window.confirm(`LM Studio is generating right now (${generating.map((m) => m.identifier).join(', ')}). Unload it anyway?`)) return
              void unloadAndServe()
            }}
            title={settings ? `runs: ${settings.unloadCommand}` : ''}
          >
            Unload LM Studio, then serve
          </button>
          <button className="btn" disabled={busy || restore === ''} onClick={() => void stopAndRestore()} title={restore ? `runs: ${restore}` : 'Set a restore command in Settings'}>
            Stop, then restore
          </button>
          {busy && <span className="muted">Working…</span>}
        </div>
        <div className="field-help mono">
          unload: {settings?.unloadCommand || '–'}
          <br />
          restore: {restore || 'not set (Settings)'}
        </div>
        {steps && steps.steps.length > 0 && (
          <div className="grid" style={{ gap: 6 }}>
            {steps.steps.map((step, i) => (
              <div key={i}>
                <div className="row" style={{ fontSize: 12 }}>
                  <span className={`tag ${step.ok ? 'ok' : 'bad'}`}>{step.ok ? 'ok' : (step.error ?? 'failed')}</span>
                  <span className="mono">{step.command}</span>
                </div>
                {step.output.trim() && <pre className="lines-box selectable" style={{ marginTop: 6, maxHeight: 120 }}>{step.output.trim().split('\n').slice(-15).join('\n')}</pre>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/** SPEC §3.10: the serving configuration as JSON, and the lines a runner needs. */
function SnapshotCard(): React.JSX.Element | null {
  const server = useDesk((s) => s.server)
  const notify = useDesk((s) => s.notify)
  const [result, setResult] = useState<SnapshotResult | null>(null)
  const [runner, setRunner] = useState<string | null>(null)
  if (!server.info.serving || !server.config) return null
  return (
    <section className="card">
      <div className="card-head">
        <h2>Serving snapshot</h2>
      </div>
      <div className="card-body grid" style={{ gap: 10 }}>
        <span className="field-help">The running configuration as JSON: the command line, every flag, the version, the checkpoint and drafter, and when it started.</span>
        <div className="row wrap">
          <button
            className="btn"
            onClick={async () => {
              const r = await window.tfdesk.exportSnapshot()
              setResult(r)
              if (!r.ok) notify({ kind: 'error', text: r.error })
            }}
          >
            <Icon name="export" size={14} /> Export snapshot
          </button>
          <button
            className="btn"
            onClick={async () => {
              const lines = await window.tfdesk.runnerLines()
              if (lines) {
                await window.tfdesk.copyText(lines)
                setRunner(lines)
              }
            }}
          >
            <Icon name="copy" size={14} /> Copy for a runner
          </button>
        </div>
        {result?.ok && (
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="mono selectable" style={{ fontSize: 12 }}>
              {result.path}
            </span>
            <button className="btn small" onClick={() => void window.tfdesk.reveal(result.path)}>
              <Icon name="folder" size={12} /> Show
            </button>
            <button className="btn small" onClick={() => void window.tfdesk.copyText(result.json)}>
              <Icon name="copy" size={12} /> Copy JSON
            </button>
          </div>
        )}
        {runner && (
          <pre className="command selectable" title="copied">
            {runner}
          </pre>
        )}
      </div>
    </section>
  )
}
