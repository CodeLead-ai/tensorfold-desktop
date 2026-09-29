import { useEffect, useState } from 'react'
import type { FlagSpec } from '@shared/config'
import type { ValidationIssue } from '@shared/validate'

interface FieldProps {
  label: React.ReactNode
  help?: string
  issue?: ValidationIssue
  set?: boolean
  onClear?: () => void
  wide?: boolean
  children: React.ReactNode
}

export function Field({ label, help, issue, set, onClear, wide, children }: FieldProps): React.JSX.Element {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
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
  invalid
}: {
  value: number | 'auto' | undefined
  onChange: (value: number | 'auto' | undefined) => void
  placeholder?: string
  allowAuto?: boolean
  invalid?: boolean
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
  accent
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
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

/** One `tensorfold serve` flag, drawn from its FlagSpec. */
export function FlagField({
  spec,
  value,
  onChange,
  issue
}: {
  spec: FlagSpec
  value: unknown
  onChange: (value: unknown) => void
  issue?: ValidationIssue
}): React.JSX.Element {
  const set = !(value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
  const placeholder = `default: ${spec.defaultText}`
  let control: React.ReactNode
  switch (spec.kind) {
    case 'int':
    case 'float':
      control = <NumberInput value={value as number | undefined} onChange={(v) => onChange(v)} placeholder={placeholder} invalid={issue?.severity === 'error'} />
      break
    case 'intOrAuto':
      control = <NumberInput value={value as number | 'auto' | undefined} onChange={(v) => onChange(v)} placeholder={placeholder} allowAuto invalid={issue?.severity === 'error'} />
      break
    case 'choice':
      control = (
        <select
          className="select"
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
          <input type="checkbox" className="switch" checked={value === true} onChange={(e) => onChange(e.target.checked ? true : undefined)} />
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
          onChange={(e) => {
            const items = e.target.value.split(/[,\s]+/).filter(Boolean)
            onChange(items.length ? items : undefined)
          }}
        />
      )
      break
    default:
      control = (
        <input className="input mono" value={typeof value === 'string' ? value : ''} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
      )
  }
  return (
    <Field label={<code>{spec.kind === 'tristate' ? `${spec.cli} / --no-${spec.cli.slice(2)}` : spec.cli}</code>} help={spec.help} issue={issue} set={set} onClear={() => onChange(undefined)}>
      {control}
    </Field>
  )
}
