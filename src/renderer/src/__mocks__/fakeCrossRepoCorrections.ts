/**
 * Scriptable `window.dm.crossRepoCorrections` and `window.dm.sourceCheckout` for tests about the Dark Mechanicus source
 * panel. Every call is recorded with its arguments; a test sets what each answers (or a handler that also changes what
 * later reads answer, as the broker's writes would) and may hold the next call of a method until it resolves it.
 */
import type { CommandResult } from '../../../shared/desktop/api'
import type { CrossRepoCorrectionsApi } from '../../../shared/desktop/crossRepoCorrections'
import type { SourceCheckoutApi, SourceCheckoutChoice, SourceCheckoutView } from '../../../shared/desktop/sourceCheckout'
import type {
  CreateCrossRepoCorrectionInput,
  CrossRepoCorrectionLinkView,
  CrossRepoCorrectionPreview,
  CrossRepoCorrectionResult,
  CrossRepoWithdrawalView,
  CrossRepoWithdrawInput
} from '../../../shared/domain/crossRepoCorrections'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import { type Deferred, deferred } from './deferred'
import { folderView } from './fixtures'

type Method = keyof CrossRepoCorrectionsApi

export function ok<T>(data: T): CommandResult<T> {
  return { ok: true, data }
}

export function refused<T>(error: DomainErrorShape): CommandResult<T> {
  return { ok: false, error }
}

const NOT_SCRIPTED: DomainErrorShape = { code: 'internal', message: 'Not scripted in this test.' }

export class FakeCrossRepoCorrections implements CrossRepoCorrectionsApi {
  calls: { method: Method; folder: string; input: unknown }[] = []
  /** What preview answers now; a handler replaces it to show the target as a request left it. */
  previewAnswer: CommandResult<CrossRepoCorrectionPreview>
  /** The folder's receipts, as list answers them. */
  links: CrossRepoCorrectionLinkView[] = []
  onCreate: (input: CreateCrossRepoCorrectionInput) => CommandResult<CrossRepoCorrectionResult> = () => refused(NOT_SCRIPTED)
  onRetry: (key: string) => CommandResult<CrossRepoCorrectionResult> = () => refused(NOT_SCRIPTED)
  onWithdraw: (input: CrossRepoWithdrawInput) => CommandResult<CrossRepoWithdrawalView> = () => refused(NOT_SCRIPTED)
  onCollect: (key: string) => CommandResult<CrossRepoCorrectionLinkView> = () => refused(NOT_SCRIPTED)
  private holds: Partial<Record<Method, Deferred[]>> = {}

  constructor(preview: CrossRepoCorrectionPreview) {
    this.previewAnswer = ok(preview)
  }

  /** Makes the next call of `method` wait until the returned deferred is resolved. */
  hold(method: Method): Deferred {
    const hold = deferred()
    this.holds[method] = [...(this.holds[method] ?? []), hold]
    return hold
  }

  callsOf(method: Method): { folder: string; input: unknown }[] {
    return this.calls.filter((call) => call.method === method).map(({ folder, input }) => ({ folder, input }))
  }

  preview(folder: string, input: unknown): Promise<CommandResult<CrossRepoCorrectionPreview>> {
    return this.answer('preview', folder, input, () => this.previewAnswer)
  }

  create(folder: string, input: CreateCrossRepoCorrectionInput): Promise<CommandResult<CrossRepoCorrectionResult>> {
    return this.answer('create', folder, input, () => this.onCreate(input))
  }

  retry(folder: string, key: string): Promise<CommandResult<CrossRepoCorrectionResult>> {
    return this.answer('retry', folder, key, () => this.onRetry(key))
  }

  withdraw(folder: string, input: CrossRepoWithdrawInput): Promise<CommandResult<CrossRepoWithdrawalView>> {
    return this.answer('withdraw', folder, input, () => this.onWithdraw(input))
  }

  list(folder: string, filter?: { reportId?: string; experimentId?: string }): Promise<CommandResult<CrossRepoCorrectionLinkView[]>> {
    return this.answer('list', folder, filter, () => ok([...this.links]))
  }

  collectResults(folder: string, key: string): Promise<CommandResult<CrossRepoCorrectionLinkView>> {
    return this.answer('collectResults', folder, key, () => this.onCollect(key))
  }

  private async answer<T>(method: Method, folder: string, input: unknown, produce: () => T): Promise<T> {
    this.calls.push({ method, folder, input })
    await this.holds[method]?.shift()?.promise
    return produce()
  }
}

export class FakeSourceCheckout implements SourceCheckoutApi {
  /** Folders passed to associate, oldest first. */
  associated: string[] = []
  picks = 0
  clears = 0
  /** What associate answers for a folder; by default that folder becomes the chosen checkout (of the same project). */
  onAssociate: (folder: string) => SourceCheckoutChoice

  constructor(public view: SourceCheckoutView) {
    this.onAssociate = (folder) => {
      this.view = { ...this.view, status: 'available', local: { path: folder, displayPath: folder, associatedAt: '2026-11-01T09:00:00.000Z' } }
      return { outcome: 'associated', checkout: this.view, folder: folderView({ path: folder, name: folder.split('/').pop() ?? folder }), added: false }
    }
  }

  get(): Promise<SourceCheckoutView> {
    return Promise.resolve(this.view)
  }

  pick(): Promise<SourceCheckoutChoice> {
    this.picks += 1
    return Promise.resolve({ outcome: 'cancelled' })
  }

  associate(folder: string): Promise<SourceCheckoutChoice> {
    this.associated.push(folder)
    return Promise.resolve(this.onAssociate(folder))
  }

  clear(): Promise<SourceCheckoutView> {
    this.clears += 1
    this.view = { status: 'none', target: null, local: null, problem: null, message: null, recovery: 'Choose your Dark Mechanicus checkout.' }
    return Promise.resolve(this.view)
  }
}
