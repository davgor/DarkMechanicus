/**
 * `window.dm.crossRepoCorrections`: corrective work a sprint retro of a tracked folder asks of the Dark Mechanicus
 * source (`../domain/crossRepoCorrections.ts`), created there by the desktop broker in main. The renderer names only
 * the source folder (a tracked one); the target is always the chosen Dark Mechanicus checkout
 * (`window.dm.sourceCheckout`), never a path the renderer gives. Each call answers like `dm:command`: `{ ok, data }`, or
 * `{ ok: false, error }` with the error's code, so the person sees exactly what happened and what to do next.
 */
import type { CommandResult } from './api'
import type {
  CreateCrossRepoCorrectionInput,
  CrossRepoCorrectionInput,
  CrossRepoCorrectionLinkView,
  CrossRepoCorrectionPreview,
  CrossRepoCorrectionResult,
  CrossRepoWithdrawalView,
  CrossRepoWithdrawInput
} from '../domain/crossRepoCorrections'

export interface CrossRepoCorrectionsApi {
  /** What creating one experiment's corrective work in the Dark Mechanicus source would write, and where it stands. Writes nothing. */
  preview(folder: string, input: CrossRepoCorrectionInput): Promise<CommandResult<CrossRepoCorrectionPreview>>
  /** Creates it (or finishes an identical earlier request); `progress` says how far it got. */
  create(folder: string, input: CreateCrossRepoCorrectionInput): Promise<CommandResult<CrossRepoCorrectionResult>>
  /** Finishes a pending request from its receipt (the draft it keeps), by key; a linked one is checked against the target. */
  retry(folder: string, key: string): Promise<CommandResult<CrossRepoCorrectionResult>>
  /**
   * Withdraws a pending request the target never accepted, so the experiment can be requested again. When the target
   * cannot be checked it is refused unless `confirmUnverified`, and answers `verified: false` (warn: it may hold the work).
   */
  withdraw(folder: string, input: CrossRepoWithdrawInput): Promise<CommandResult<CrossRepoWithdrawalView>>
  /** The folder's receipts, newest first: all, or those of one report revision's experiments or one experiment. */
  list(folder: string, filter?: { reportId?: string; experimentId?: string }): Promise<CommandResult<CrossRepoCorrectionLinkView[]>>
  /**
   * Brings back what the target epic of a linked request holds for measuring the experiment (its sealed scorecards,
   * scope starts, corrective tickets and planned sizes) into the receipt, so the experiment's result can cite a grade
   * of it. Reads the target; writes only the source's receipt.
   */
  collectResults(folder: string, key: string): Promise<CommandResult<CrossRepoCorrectionLinkView>>
}
