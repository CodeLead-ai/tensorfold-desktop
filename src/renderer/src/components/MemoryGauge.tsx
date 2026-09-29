import { useRef } from 'react'
import type { MemoryBudgetStartup } from '@shared/events'
import { gaugeOf, type Health, type HealthSample } from '@shared/health'
import { gib, percent } from '../lib/format'

interface Props {
  sample: HealthSample | null
  budgetLine: MemoryBudgetStartup | null
  serving: boolean
}

/**
 * SPEC §3.3 and §2.4: active over mlx_budget, with cache and peak as marks, against the whole budget; the
 * numbers in GiB, and the startup line's budget sentence quoted once.
 */
export function MemoryGauge({ sample, budgetLine, serving }: Props): React.JSX.Element {
  const lastOk = useRef<{ health: Health; at: number } | null>(null)
  if (sample?.ok) lastOk.current = { health: sample.health, at: sample.at }
  if (!serving) lastOk.current = null
  const shown = lastOk.current

  if (!shown) {
    return (
      <div className="empty">
        {serving ? (sample && !sample.ok ? `/health does not answer: ${sample.error}` : 'Reading /health…') : 'The gauge follows /health every 2 s while the server is serving.'}
      </div>
    )
  }
  const m = shown.health.memory
  const g = gaugeOf(m)
  const hot = (g.usedOfMlx ?? 0) > 0.95
  const pct = (f: number | null): string => `${((f ?? 0) * 100).toFixed(3)}%`
  return (
    <div>
      <div className="gauge-top">
        <span className={`gauge-big ${hot ? 'bad' : ''}`}>{percent(g.usedOfMlx)}</span>
        <span className="muted">of what MLX may use{m.mlx_budget ? ` (${gib(m.mlx_budget, 1)} GiB)` : ''} is active</span>
        {shown.health.warming && <span className="tag">warming</span>}
      </div>
      <div className="gauge-bar" role="img" aria-label={`active ${gib(m.active)} GiB of ${gib(g.scaleBytes)} GiB`}>
        <div className="held" style={{ width: pct(g.heldFrac) }} />
        <div className={`fill ${hot ? 'hot' : ''}`} style={{ width: pct(g.activeFrac) }} />
        <div className="mark peak" style={{ left: pct(g.peakFrac) }} title={`peak ${gib(m.peak)} GiB`} />
        {g.mlxBudgetFrac !== null && <div className="mark mlx" style={{ left: pct(g.mlxBudgetFrac) }} title={`MLX may use ${gib(m.mlx_budget)} GiB`} />}
      </div>
      <div className="gauge-scale">
        <span className="start">0</span>
        {g.mlxBudgetFrac !== null && g.mlxBudgetFrac < 0.9 && <span style={{ left: pct(g.mlxBudgetFrac) }}>MLX {gib(m.mlx_budget, 1)}</span>}
        <span className="end">{m.budget ? 'budget ' : ''}{gib(g.scaleBytes, 1)} GiB</span>
      </div>
      <div className="legend">
        <Item swatch="active" label="active" value={gib(m.active)} />
        <Item swatch="cache" label="cache (freed, kept)" value={gib(m.cache)} />
        <Item swatch="peak" label="peak" value={gib(m.peak)} />
        <Item label="footprint" value={gib(m.footprint)} />
        <Item swatch="mlx" label="MLX budget" value={gib(m.mlx_budget)} />
        <Item label="budget" value={gib(m.budget)} />
      </div>
      {budgetLine && <blockquote className="quote selectable">{budgetLine.sentence}</blockquote>}
      {sample && !sample.ok && <div className="field-issue warning" style={{ marginTop: 10 }}>/health stopped answering ({sample.error}); showing the last reading.</div>}
    </div>
  )
}

function Item({ label, value, swatch }: { label: string; value: string; swatch?: string }): React.JSX.Element {
  return (
    <div className="legend-item">
      <span className="label">
        {swatch && <i className={`swatch ${swatch}`} />}
        {label}
      </span>
      <span className="value">{value === '–' ? '–' : `${value} GiB`}</span>
    </div>
  )
}
