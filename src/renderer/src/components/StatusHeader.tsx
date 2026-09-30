import { drafterName, lanesOf } from '@shared/session'
import { basename, duration, int } from '../lib/format'
import { useNow } from '../lib/hooks'
import { useDesk } from '../store'
import { Icon } from './Icon'

/** SPEC §3.2: model id, port, context, drafts and drafter, sampling, loaded in, uptime, version, backend, lanes. */
export function StatusHeader(): React.JSX.Element {
  const server = useDesk((s) => s.server)
  const health = useDesk((s) => s.health)
  const form = useDesk((s) => s.form)
  const busy = useDesk((s) => s.busy)
  const { start, stop, restart, kill } = useDesk.getState()
  const now = useNow(1000)
  const { status, info } = server
  const serving = info.serving
  const exit = server.lastExit
  const died = status === 'stopped' && exit !== null && !exit.requested

  let label = 'Stopped'
  if (status === 'serving') label = 'Serving'
  else if (status === 'loading') label = `Loading ${duration(now - (server.startedAt ?? now))}`
  else if (status === 'stopping') label = server.killAt && server.killAt > now ? `Stopping · SIGKILL in ${Math.ceil((server.killAt - now) / 1000)} s` : 'Stopping'
  else if (died) label = exit.spawnError ? 'Did not start' : `Died · ${exit.signal ?? `exit ${exit.code}`}`
  const stateClass = died ? 'died' : status

  const model = serving?.model ?? info.loading?.model ?? basename((server.config ?? form).model || 'no model')
  const live = status === 'serving' || status === 'loading' || status === 'stopping'
  const maxBatch = health?.ok ? health.health.max_batch_size : undefined
  const lanes = lanesOf(info, maxBatch)
  const sampling = serving ? (serving.greedy ? 'greedy' : Object.entries(serving.sampling).map(([k, v]) => `${k.replace('temperature', 'T').replace('top_k', 'k').replace('top_p', 'p').replace('min_p', 'min p')} ${v}`).join(' · ')) : null
  const waiting = status === 'serving' && info.memoryWait && info.memoryWait.waiting > 0 ? info.memoryWait : null

  return (
    <header className="header">
      <div className="header-main">
        <div className="header-title">
          <span className={`state ${stateClass}`}>
            <i className="dot" />
            {label}
          </span>
          <span className="header-model selectable" title={server.config?.model ?? form.model}>
            {model}
          </span>
        </div>
        <div className="chips">
          {live ? (
            <>
              <Chip k="port" v={String(serving?.port ?? server.config?.endpoint.port ?? 8080)} />
              <Chip k="context" v={serving ? (serving.context === null ? 'unlimited' : int(serving.context)) : int(server.config?.generation.context)} />
              {info.resumable && (
                <Chip
                  k="prompts kept"
                  v={`≤ ${int(info.resumable.tokens)}`}
                  title="A request up to this many tokens (prompt and reply) keeps its prompt for the next turn; a longer one is served, and its next turn prefills again"
                />
              )}
              {serving && <Chip k="drafts" v={serving.drafts ? (drafterName(info) ?? 'on') : 'off'} />}
              {sampling && <Chip k="sampling" v={sampling} />}
              {serving && <Chip k="loaded in" v={`${serving.loadedInS.toFixed(1)} s`} />}
              {server.servingAt && status === 'serving' && <Chip k="up" v={duration(now - server.servingAt)} />}
              {server.version && <Chip k="tensorfold" v={server.version} />}
              <Chip k="backend" v={(serving?.backend ?? info.loading?.backend ?? 'mlx').toUpperCase()} />
              {lanes !== null && <Chip k="lanes" v={String(lanes)} />}
              {waiting && (
                <Chip
                  tone="warn"
                  k="waiting for memory"
                  v={`${waiting.waiting} of ${waiting.streams} streams`}
                  title="Memory ran short: the newest streams pause until the older ones finish. If it gets shorter still, the newest ends with an error; a smaller --parallel avoids that"
                />
              )}
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              {died
                ? exit.spawnError ?? `The server died ${exit.during === 'loading' ? 'while loading' : 'while serving'}; the Server view shows its last lines.`
                : exit
                  ? `Stopped at ${new Date(exit.at).toLocaleTimeString()} · exit ${exit.signal ?? exit.code}`
                  : 'Not running. Start it from here or from the Server view.'}
            </span>
          )}
        </div>
      </div>
      <div className="header-actions">
        {status === 'stopped' && (
          <button className="btn primary" disabled={busy} onClick={() => void start()}>
            <Icon name="play" size={14} filled /> Start
          </button>
        )}
        {(status === 'loading' || status === 'serving') && (
          <>
            <button className="btn" disabled={busy} onClick={() => void restart()} title="Stop, then start with the form as it is now">
              <Icon name="restart" size={14} /> Restart
            </button>
            <button className="btn danger" onClick={() => void stop()}>
              <Icon name="stop" size={13} filled /> Stop
            </button>
          </>
        )}
        {status === 'stopping' && (
          <button className="btn danger" onClick={() => void kill()} title="Send SIGKILL now; the conversations being saved are lost">
            <Icon name="kill" size={14} /> Force stop
          </button>
        )}
      </div>
    </header>
  )
}

function Chip({ k, v, title, tone }: { k: string; v: string; title?: string; tone?: 'warn' }): React.JSX.Element {
  return (
    <span className={`chip ${tone ?? ''}`} title={title}>
      {k} <b>{v}</b>
    </span>
  )
}
