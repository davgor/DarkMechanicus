/**
 * The sprint delivery section of an acceptance node's draft editor: declare or clear where the sprint's increment is
 * delivered after its checkpoint, applied on its own as one `update_sprint` draft operation.
 */
import { useState } from 'react'
import type { DraftOp } from '../../../shared/domain/api'
import type { SprintDef } from '../../../shared/domain/bundle'
import type { Result } from '../epic/workspaceActions'
import { deliveryForm, type DeliveryForm, formToDelivery, withRelease } from './deliveryForm'

interface DeliveryFieldsProps {
  sprint: Pick<SprintDef, 'id' | 'delivery'>
  busy: boolean
  applyOps(ops: DraftOp[]): Promise<Result<unknown>>
}

type Notice = { tone: 'info' | 'error'; text: string } | null

function DeliveryInputs(props: { form: DeliveryForm; disabled: boolean; onChange(form: DeliveryForm): void }): JSX.Element {
  const { form, disabled, onChange } = props
  const off = disabled || !form.deliver
  return (
    <>
      <label className="tp-check-field">
        <input type="checkbox" checked={form.deliver} disabled={disabled} onChange={(event) => onChange({ ...form, deliver: event.target.checked })} />
        Deliver this sprint after its checkpoint
      </label>
      <label className="tp-field">
        <span>Target branch</span>
        <input className="tp-input" type="text" value={form.target} disabled={off} onChange={(event) => onChange({ ...form, target: event.target.value })} />
      </label>
      <label className="tp-check-field">
        <input type="checkbox" checked={form.release} disabled={off} onChange={(event) => onChange(withRelease(form, event.target.checked))} />
        Require a release that contains it
      </label>
      <label className="tp-check-field tp-delivery-nested">
        <input
          type="checkbox"
          checked={form.release && form.verifyInstalled}
          disabled={off || !form.release}
          onChange={(event) => onChange({ ...form, verifyInstalled: event.target.checked })}
        />
        Verify the installed app runs that release
      </label>
    </>
  )
}

/** The sprint's delivery declaration, edited on its acceptance node. */
export function DeliveryFields(props: DeliveryFieldsProps): JSX.Element {
  const [form, setForm] = useState(() => deliveryForm(props.sprint))
  const [notice, setNotice] = useState<Notice>(null)
  const delivery = formToDelivery(form)
  const invalid = delivery !== null && 'error' in delivery ? delivery.error : null
  const apply = async (): Promise<void> => {
    if (delivery !== null && 'error' in delivery) {
      return
    }
    const result = await props.applyOps([{ op: 'update_sprint', sprint: props.sprint.id, patch: { delivery } }])
    setNotice(result.ok ? { tone: 'info', text: delivery === null ? 'Delivery cleared in the draft.' : 'Delivery applied to the draft.' } : { tone: 'error', text: result.failure.message })
  }
  return (
    <section className="tp-fieldset tp-delivery" aria-label="Sprint delivery">
      <h3 className="ew-eyebrow">SPRINT DELIVERY</h3>
      <DeliveryInputs
        form={form}
        disabled={props.busy}
        onChange={(next) => {
          setNotice(null)
          setForm(next)
        }}
      />
      {invalid === null ? null : <p className="tp-message is-error">{invalid}</p>}
      <div className="tp-delivery-actions">
        <button type="button" className="btn" disabled={props.busy || invalid !== null} onClick={() => void apply()}>
          Apply delivery
        </button>
      </div>
      {notice === null ? null : (
        <p className={`tp-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
    </section>
  )
}
