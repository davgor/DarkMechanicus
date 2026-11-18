/**
 * The planned budget a person types in the draft editor: tokens in tokens and active time in minutes (stored as
 * milliseconds), with where the numbers came from. Both amounts blank leaves the ticket without a budget; nothing is
 * filled in. The bounds are the draft schema's: each amount a whole number of its unit from 1 to 10¹². Also the text for
 * the ticket's saved budget versions, so a person sees which one the run froze at dispatch and which only apply later.
 */
import { BUDGET_BASES, type BudgetBasis, type TicketBudget } from '../../../shared/domain/bundle'
import type { BudgetVersionView, PlannedBudgetView } from '../../../shared/domain/metrics'
import { amountText, durationText, localTime } from '../scorecard/scorecardFormat'

const MAX_AMOUNT = 1_000_000_000_000
const MS_PER_MINUTE = 60_000

export const BASIS_LABELS: Readonly<Record<BudgetBasis, string>> = {
  person_estimate: 'A person’s estimate',
  planner_estimate: 'The planner’s estimate',
  prior_tickets: 'Similar earlier tickets'
}

/** The form's text: what the person typed, kept as typed until it is set. */
export interface BudgetText {
  tokens: string
  minutes: string
  basis: BudgetBasis | ''
}

export function budgetText(budget: TicketBudget | null | undefined): BudgetText {
  return {
    tokens: budget?.tokens === undefined ? '' : String(budget.tokens),
    // Rounded to 5 decimals: within 0.3 ms of the stored whole milliseconds, so an untouched field converts back exactly.
    minutes: budget?.activeMs === undefined ? '' : String(Number((budget.activeMs / MS_PER_MINUTE).toFixed(5))),
    basis: budget?.basis ?? ''
  }
}

export const sameText = (a: BudgetText, b: BudgetText): boolean => a.tokens.trim() === b.tokens.trim() && a.minutes.trim() === b.minutes.trim() && a.basis === b.basis

type BudgetParse = { ok: true; budget: TicketBudget | null } | { ok: false; message: string }

/**
 * A typed amount in its stored unit (`toUnit`): undefined when blank, null when it is not plain digits (with a decimal
 * point when `decimal`) or not a whole number from 1 to 10¹² once converted. Text such as `1e`, `-` or `1e-9` is refused,
 * never read as blank.
 */
function amountIn(text: string, decimal: boolean, toUnit: (typed: number) => number): number | undefined | null {
  const trimmed = text.trim()
  if (trimmed === '') {
    return undefined
  }
  if (!(decimal ? /^(\d+\.?\d*|\.\d+)$/ : /^\d+$/).test(trimmed)) {
    return null
  }
  const amount = toUnit(Number(trimmed))
  return Number.isInteger(amount) && amount >= 1 && amount <= MAX_AMOUNT ? amount : null
}

/** Typed minutes as stored whole milliseconds, by the same strict rule the budget is set by (undefined blank, null refused). */
export const minutesToMs = (text: string): number | undefined | null => amountIn(text, true, (typed) => Math.round(typed * MS_PER_MINUTE))

/** The budget the text sets: null when both amounts are blank (no budget), else each amount within its bounds. */
export function parseBudget(text: BudgetText): BudgetParse {
  const tokens = amountIn(text.tokens, false, (typed) => typed)
  if (tokens === null) {
    return { ok: false, message: `Tokens are a whole number from 1 to ${MAX_AMOUNT.toLocaleString('en-US')}.` }
  }
  // Minutes are stored as whole milliseconds; below half a millisecond rounds to 0 and is refused.
  const activeMs = minutesToMs(text.minutes)
  if (activeMs === null) {
    return { ok: false, message: 'Active time is a number of minutes, more than 0 and at most about 31 years (10¹² milliseconds).' }
  }
  if (tokens === undefined && activeMs === undefined) {
    return text.basis === '' ? { ok: true, budget: null } : { ok: false, message: 'A basis needs an amount: enter tokens, minutes or both, or set the basis to Not stated.' }
  }
  return { ok: true, budget: { ...(tokens === undefined ? {} : { tokens }), ...(activeMs === undefined ? {} : { activeMs }), ...(text.basis === '' ? {} : { basis: text.basis }) } }
}

/** Picks a basis from a `<select>` value ('' for not stated). */
export function basisOf(value: string): BudgetBasis | '' {
  return BUDGET_BASES.find((basis) => basis === value) ?? ''
}

/** A budget at a glance, each amount in its unit. */
export function budgetSummary(budget: TicketBudget | null | undefined): string {
  if (budget === null || budget === undefined) {
    return 'no budget'
  }
  const parts = [
    budget.tokens === undefined ? null : amountText(budget.tokens, 'tokens'),
    budget.activeMs === undefined ? null : `${durationText(budget.activeMs)} active`
  ].filter((part): part is string => part !== null)
  return `${parts.join(' and ')} · ${budget.basis === undefined ? 'basis not stated' : BASIS_LABELS[budget.basis]}`
}

const STATUS_TEXT: Readonly<Record<Exclude<BudgetVersionView['status'], 'pinned'>, string>> = {
  superseded: 'an earlier version',
  prospective: 'prospective: applies only to later dispatches, never to a grade already read'
}

const PINNED_TEXT: Readonly<Record<PlannedBudgetView['state'], string>> = {
  frozen: 'frozen at this run’s dispatch: the one its grade uses',
  planned: 'applies when the ticket is dispatched',
  none: 'in effect, but sets no usable budget'
}

/** One saved version: its amount in its unit, its basis, the save that froze it and where it stands for the run. */
export function versionText(version: BudgetVersionView, budget: PlannedBudgetView): string {
  const amount = version.value === null ? 'cleared' : amountText(version.value, version.unit === 'tokens' ? 'tokens' : 'milliseconds')
  const basis = version.value === null ? '' : ` · ${version.basis === null ? 'basis not stated' : BASIS_LABELS[version.basis]}`
  const standing = version.status === 'pinned' ? PINNED_TEXT[budget.state] : STATUS_TEXT[version.status]
  return `v${version.version} · ${amount}${basis} · saved in revision ${version.revisionNumber} at ${localTime(version.frozenAt)} · ${standing}`
}
