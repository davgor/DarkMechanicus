import { useState } from 'react'
import {
  MODALITIES,
  REASONING_LEVELS,
  TICKET_PRIORITIES,
  TOOL_CAPABILITIES,
  WORK_TYPES,
  type PlanBundle
} from '../../../shared/domain/bundle'
import { Markdown } from '../markdown/Markdown'
import {
  addCriterion,
  editCriterion,
  moveCriterion,
  pick,
  prerequisiteOptions,
  removeCriterion,
  sprintOptions,
  toggleValue,
  type TicketForm
} from './ticketForm'
import { MODALITY_LABELS, REASONING_LABELS, TOOL_LABELS, WORK_TYPE_LABELS } from './ticketView'

interface FieldProps {
  form: TicketForm
  update(form: TicketForm): void
}

const PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' } as const

export function BasicFields({ form, update }: FieldProps): JSX.Element {
  const [preview, setPreview] = useState(false)
  return (
    <>
      <label className="tp-field">
        <span>Title</span>
        <input className="tp-input tp-title-input" value={form.title} onChange={(event) => update({ ...form, title: event.target.value })} />
      </label>
      <div className="tp-field">
        <div className="tp-field-head">
          <span>Description</span>
          <div className="ew-toggle" role="group" aria-label="Description mode">
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
        </div>
        {preview ? (
          <div className="tp-preview">
            <Markdown source={form.body} />
          </div>
        ) : (
          <textarea
            className="tp-input"
            aria-label="Description (Markdown)"
            rows={8}
            value={form.body}
            onChange={(event) => update({ ...form, body: event.target.value })}
          />
        )}
      </div>
    </>
  )
}

function CriterionRow(props: FieldProps & { index: number; text: string }): JSX.Element {
  const { form, update, index } = props
  const number = index + 1
  return (
    <li className="tp-criterion-row">
      <input
        className="tp-input"
        aria-label={`Criterion ${number}`}
        value={props.text}
        onChange={(event) => update(editCriterion(form, index, event.target.value))}
      />
      <button type="button" className="ew-icon-btn" aria-label={`Move criterion ${number} up`} onClick={() => update(moveCriterion(form, index, -1))}>
        ↑
      </button>
      <button type="button" className="ew-icon-btn" aria-label={`Move criterion ${number} down`} onClick={() => update(moveCriterion(form, index, 1))}>
        ↓
      </button>
      <button type="button" className="ew-icon-btn" aria-label={`Remove criterion ${number}`} onClick={() => update(removeCriterion(form, index))}>
        ✕
      </button>
    </li>
  )
}

export function CriteriaFields({ form, update }: FieldProps): JSX.Element {
  return (
    <fieldset className="tp-fieldset">
      <legend className="ew-eyebrow">ACCEPTANCE CRITERIA</legend>
      <ol className="tp-criteria-edit">
        {form.criteria.map((row, index) => (
          <CriterionRow key={row.key} form={form} update={update} index={index} text={row.text} />
        ))}
      </ol>
      <button type="button" className="btn btn-ghost" onClick={() => update(addCriterion(form))}>
        + Criterion
      </button>
    </fieldset>
  )
}

export function DetailFields({ form, update, bundle }: FieldProps & { bundle: PlanBundle }): JSX.Element {
  return (
    <fieldset className="tp-fieldset tp-grid">
      <legend className="ew-eyebrow">DETAILS</legend>
      <label className="tp-field">
        <span>Sprint</span>
        <select value={form.sprintId} onChange={(event) => update({ ...form, sprintId: event.target.value })}>
          {sprintOptions(bundle).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="tp-field">
        <span>Priority</span>
        <select
          value={form.priority}
          onChange={(event) => update({ ...form, priority: pick(TICKET_PRIORITIES, event.target.value, form.priority) })}
        >
          {TICKET_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </select>
      </label>
      <label className="tp-field">
        <span>Tags</span>
        <input className="tp-input" value={form.tags} placeholder="comma, separated" onChange={(event) => update({ ...form, tags: event.target.value })} />
      </label>
      <label className="tp-check-field">
        <input type="checkbox" checked={form.optional} onChange={(event) => update({ ...form, optional: event.target.checked })} />
        <span>Optional (does not gate the sprint)</span>
      </label>
    </fieldset>
  )
}

export function PrerequisiteFields(props: FieldProps & { bundle: PlanBundle; ticketId: string }): JSX.Element {
  const { form, update, bundle } = props
  const [candidate, setCandidate] = useState('')
  const labels = new Map(bundle.tickets.map((item) => [item.id, `${item.key} ${item.title}`]))
  const add = (): void => {
    update({ ...form, prerequisites: [...form.prerequisites, candidate] })
    setCandidate('')
  }
  return (
    <fieldset className="tp-fieldset">
      <legend className="ew-eyebrow">REQUIRES</legend>
      {form.prerequisites.length === 0 ? <p className="ew-muted">No prerequisites.</p> : null}
      <ul className="tp-prereqs">
        {form.prerequisites.map((id) => (
          <li key={id}>
            <span>{labels.get(id) ?? id}</span>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label={`Remove prerequisite ${labels.get(id) ?? id}`}
              onClick={() => update({ ...form, prerequisites: form.prerequisites.filter((item) => item !== id) })}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="tp-inline">
        <select aria-label="Add prerequisite" value={candidate} onChange={(event) => setCandidate(event.target.value)}>
          <option value="">Choose a ticket…</option>
          {prerequisiteOptions(bundle, props.ticketId, form).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn" disabled={candidate === ''} onClick={add}>
          Add
        </button>
      </div>
    </fieldset>
  )
}

function CheckboxGroup<T extends string>(props: {
  legend: string
  options: readonly T[]
  labels: Record<T, string>
  selected: T[]
  onToggle(value: T): void
}): JSX.Element {
  return (
    <fieldset className="tp-fieldset tp-checks-group">
      <legend>{props.legend}</legend>
      {props.options.map((option) => (
        <label key={option} className="tp-check-field">
          <input type="checkbox" checked={props.selected.includes(option)} onChange={() => props.onToggle(option)} />
          <span>{props.labels[option]}</span>
        </label>
      ))}
    </fieldset>
  )
}

function ProfileSelects({ form, update }: FieldProps): JSX.Element {
  return (
    <div className="tp-grid">
      <label className="tp-field">
        <span>Work type</span>
        <select value={form.workType} onChange={(event) => update({ ...form, workType: pick(WORK_TYPES, event.target.value, form.workType) })}>
          {WORK_TYPES.map((type) => (
            <option key={type} value={type}>
              {WORK_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label className="tp-field">
        <span>Reasoning</span>
        <select
          value={form.reasoningLevel}
          onChange={(event) => update({ ...form, reasoningLevel: pick(REASONING_LEVELS, event.target.value, form.reasoningLevel) })}
        >
          {REASONING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {REASONING_LABELS[level]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export function CapabilityFields({ form, update }: FieldProps): JSX.Element {
  return (
    <fieldset className="tp-fieldset">
      <legend className="ew-eyebrow">CAPABILITY PROFILE</legend>
      <ProfileSelects form={form} update={update} />
      <label className="tp-field">
        <span>Reasoning rationale</span>
        <input className="tp-input" value={form.rationale} onChange={(event) => update({ ...form, rationale: event.target.value })} />
      </label>
      <CheckboxGroup
        legend="Tools"
        options={TOOL_CAPABILITIES}
        labels={TOOL_LABELS}
        selected={form.tools}
        onToggle={(tool) => update({ ...form, tools: toggleValue(form.tools, tool) })}
      />
      <CheckboxGroup
        legend="Modalities"
        options={MODALITIES}
        labels={MODALITY_LABELS}
        selected={form.modalities}
        onToggle={(modality) => update({ ...form, modalities: toggleValue(form.modalities, modality) })}
      />
      <div className="tp-grid">
        <label className="tp-field">
          <span>Skills</span>
          <input className="tp-input" value={form.skills} placeholder="TypeScript, SQLite" onChange={(event) => update({ ...form, skills: event.target.value })} />
        </label>
        <label className="tp-field">
          <span>Estimated input tokens</span>
          <input className="tp-input" inputMode="numeric" value={form.tokens} onChange={(event) => update({ ...form, tokens: event.target.value })} />
        </label>
      </div>
    </fieldset>
  )
}
