import { useId } from 'react'

interface FieldProps {
  label: string
  value: string
  onChange(value: string): void
  /** Renders a textarea with this many rows instead of a single-line input. */
  rows?: number
  maxLength?: number
  /** Helper text linked to the control with aria-describedby. */
  hint?: string
}

/** A labelled text control. The hint sits beside the label, not inside it. */
export function Field({ label, value, onChange, rows, maxLength, hint }: FieldProps): JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const shared = {
    id,
    className: 'input',
    value,
    maxLength,
    'aria-describedby': hint === undefined ? undefined : hintId
  }
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {rows === undefined ? (
        <input {...shared} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <textarea {...shared} rows={rows} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint === undefined ? null : (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  )
}
