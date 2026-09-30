import { useEffect, useState } from 'react'
import type { FlagSpec } from '@shared/config'
import type { HelpFlag } from '@shared/serveHelp'
import type { ValidationIssue } from '@shared/validate'

interface FieldProps {
  label: React.ReactNode
  help?: string
  issue?: ValidationIssue
  set?: boolean
  onClear?: () => void
  wide?: boolean
  /** Shown dimmed: the installed TensorFold does not have this flag. */
  dim?: boolean
  children: React.ReactNode
}

export function Field({ label, help, issue, set, onClear, wide, dim, children }: FieldProps): React.JSX.Element {
  return (
    <label
      className={`field ${wide ? 'wide' : ''} ${dim ? 'dim' : ''}`}
      onClick={(e) => {
        // A label hands a click on its text to its first labelable descendant, and that is the reset button
        // (or a segment) when there is one: clicking a flag's name would clear it. Focus the field instead.
        if ((e.target as HTMLElement).closest('input, select, textarea, button, a')) return
        e.preventDefault()
        e.currentTarget.querySelector<HTMLElement>('input:not([type=checkbox]), select, textarea')?.focus()
      }}
    >
      <span className="field-label">
        {label}
        {set && onClear && (
          <button type="button" className="clear" onClick={(e) => (e.preventDefault(), onClear())} title="Not passed: TensorFold's default applies">
            reset
          </button>
        )}
      </span>
      {children}
      {issue ? <span className={`field-issue ${issue.severity}`}>{issue.message}</span> : help ? <span className="field-help">{help}</span> : null}
    </label>
  )
}

/** Text that becomes a number, `auto`, or nothing; bad text is kept visible and reported, never lost. */
export function NumberInput({
  value,
  onChange,
  placeholder,
  allowAuto = false,
  invalid,
  disabled
}: {
  value: number | 'auto' | undefined
  onChange: (value: number | 'auto' | undefined) => void
  placeholder?: string
  allowAuto?: boolean
  invalid?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const shown = value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? '' : String(value)
  const [raw, setRaw] = useState(shown)
  useEffect(() => {
    setRaw((current) => {
      const parsed = parse(current)
      return parsed === value || (Number.isNaN(parsed as number) && Number.isNaN(value as number)) ? current : shown
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function parse(text: string): number | 'auto' | undefined {
    const t = text.trim()
    if (t === '') return undefined
    if (allowAuto && t === 'auto') return 'auto'
    const n = Number(t.replace(/,/g, ''))
    return Number.isFinite(n) ? n : NaN
  }

  return (
    <input
      className={`input mono ${invalid ? 'invalid' : ''}`}
      value={raw}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => {
        setRaw(e.target.value)
        onChange(parse(e.target.value))
      }}
    />
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accent,
  disabled
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  accent?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          disabled={disabled}
          aria-checked={value === o.value}
          className={`${value === o.value ? 'on' : ''} ${accent ? 'accent' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * One `tensorfold serve` flag, drawn from its FlagSpec. `missing` says the installed TensorFold lacks it: the
 * field is dimmed, and only a value already set can be changed (to clear it).
 */
export function FlagField({
  spec,
  value,
  onChange,
  issue,
  missing
}: {
  spec: FlagSpec
  value: unknown
  onChange: (value: unknown) => void
  issue?: ValidationIssue
  missing?: string
}): React.JSX.Element {
  const set = !(value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
  const placeholder = `default: ${spec.defaultText}`
  const disabled = missing !== undefined && !set
  let control: React.ReactNode
  switch (spec.kind) {
    case 'int':
    case 'float':
      control = <NumberInput value={value as number | undefined} onChange={(v) => onChange(v)} placeholder={placeholder} invalid={issue?.severity === 'error'} disabled={disabled} />
      break
    case 'intOrAuto':
      control = <NumberInput value={value as number | 'auto' | undefined} onChange={(v) => onChange(v)} placeholder={placeholder} allowAuto invalid={issue?.severity === 'error'} disabled={disabled} />
      break
    case 'choice':
      control = (
        <select
          className="select"
          disabled={disabled}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? undefined : spec.key === 'tp' || spec.key === 'rank' ? Number(v) : v)
          }}
        >
          <option value="">{placeholder}</option>
          {(spec.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )
      break
    case 'bool':
      control = (
        <span className="row" style={{ height: 30 }}>
          <input type="checkbox" className="switch" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />
          <span className="muted" style={{ fontSize: 12 }}>
            {value === true ? `passes ${spec.cli}` : spec.defaultText}
          </span>
        </span>
      )
      break
    case 'tristate':
      control = (
        <Segmented
          options={[
            { value: 'default', label: `default (${spec.defaultText})` },
            { value: 'on', label: 'on' },
            { value: 'off', label: 'off' }
          ]}
          value={value === true ? 'on' : value === false ? 'off' : 'default'}
          onChange={(v) => onChange(v === 'on' ? true : v === 'off' ? false : undefined)}
          disabled={disabled}
        />
      )
      break
    case 'list':
      control = (
        <input
          className="input mono"
          value={Array.isArray(value) ? (value as string[]).join(', ') : ''}
          placeholder="none"
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => {
            const items = e.target.value.split(/[,\s]+/).filter(Boolean)
            onChange(items.length ? items : undefined)
          }}
        />
      )
      break
    default:
      control = (
        <input className="input mono" value={typeof value === 'string' ? value : ''} placeholder={placeholder} spellCheck={false} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
      )
  }
  return (
    <Field
      label={<code>{spec.kind === 'tristate' ? `${spec.cli} / --no-${spec.cli.slice(2)}` : spec.cli}</code>}
      help={missing ?? spec.help}
      issue={issue}
      set={set}
      dim={missing !== undefined}
      onClear={() => onChange(undefined)}
    >
      {control}
    </Field>
  )
}

/**
 * A flag of the installed binary that the app's table lacks (a newer TensorFold's), drawn from its `serve --help`
 * entry: a switch, a choice, or a value passed as typed. `value` is the flag's state in the form's `extra`:
 * `on` and `off` stand for `--flag` and `--no-flag` of a switch that has both.
 */
export function ExtraField({
  flag,
  value,
  onChange,
  issue
}: {
  flag: HelpFlag
  value: string | 'on' | 'off' | undefined
  onChange: (value: string | 'on' | 'off' | undefined) => void
  issue?: ValidationIssue
}): React.JSX.Element {
  const placeholder = `default: ${flag.defaultText ?? '–'}`
  let control: React.ReactNode
  if (flag.choices) {
    control = (
      <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        <option value="">{placeholder}</option>
        {flag.choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    )
  } else if (flag.metavar) {
    control = <input className="input mono" value={value ?? ''} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
  } else if (flag.negative) {
    control = (
      <Segmented
        options={[
          { value: 'default', label: `default (${flag.defaultText ?? '–'})` },
          { value: 'on', label: 'on' },
          { value: 'off', label: 'off' }
        ]}
        value={value === 'on' || value === 'off' ? value : 'default'}
        onChange={(v) => onChange(v === 'default' ? undefined : v)}
      />
    )
  } else {
    control = (
      <span className="row" style={{ height: 30 }}>
        <input type="checkbox" className="switch" checked={value === 'on'} onChange={(e) => onChange(e.target.checked ? 'on' : undefined)} />
        <span className="muted" style={{ fontSize: 12 }}>
          {value === 'on' ? `passes ${flag.cli}` : 'not passed'}
        </span>
      </span>
    )
  }
  return (
    <Field
      label={<code>{flag.negative ? `${flag.cli} / ${flag.negative}` : flag.metavar ? `${flag.cli} ${flag.metavar}` : flag.cli}</code>}
      help={flag.help + (flag.defaultText ? ` (default: ${flag.defaultText})` : '')}
      issue={issue}
      set={value !== undefined}
      onClear={() => onChange(undefined)}
    >
      {control}
    </Field>
  )
}
