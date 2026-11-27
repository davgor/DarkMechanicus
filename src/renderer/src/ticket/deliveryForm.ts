/**
 * The sprint delivery a person edits on the sprint's acceptance node: whether the sprint delivers after its checkpoint,
 * the target branch, and whether a release must contain it and the installed app must run that release. Verifying the
 * installed app needs a release, so it is off whenever the release is.
 */
import type { SprintDef, SprintDelivery } from '../../../shared/domain/bundle'
import { epicBranchName } from '../../../shared/domain/branchName'

const DEFAULT_TARGET = 'main'

/** The form's values: the target branch as typed. */
export interface DeliveryForm {
  deliver: boolean
  target: string
  release: boolean
  verifyInstalled: boolean
}

/** The form for the sprint's declared delivery; a sprint without one starts unchecked on `main`. */
export function deliveryForm(sprint: Pick<SprintDef, 'delivery'>): DeliveryForm {
  const delivery = sprint.delivery
  if (delivery === undefined) {
    return { deliver: false, target: DEFAULT_TARGET, release: false, verifyInstalled: false }
  }
  return { deliver: true, target: delivery.target, release: delivery.release, verifyInstalled: delivery.release && delivery.verifyInstalled }
}

/** Turns the release on or off; turning it off unchecks verifying the installed app. */
export function withRelease(form: DeliveryForm, release: boolean): DeliveryForm {
  return { ...form, release, verifyInstalled: release && form.verifyInstalled }
}

/** The delivery the form declares, null when the sprint delivers nothing, or the reason the target branch is refused. */
export function formToDelivery(form: DeliveryForm): SprintDelivery | null | { error: string } {
  if (!form.deliver) {
    return null
  }
  const target = form.target.trim()
  if (!epicBranchName.safeParse(target).success) {
    return { error: target === '' ? 'Enter a target branch.' : `“${target}” is not a valid branch name.` }
  }
  return { target, release: form.release, verifyInstalled: form.release && form.verifyInstalled }
}
