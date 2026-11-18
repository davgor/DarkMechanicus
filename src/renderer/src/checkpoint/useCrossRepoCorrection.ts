/**
 * The state and requests of an experiment's Dark Mechanicus source panel (`CrossRepoCorrection`): the chosen checkout
 * (`window.dm.sourceCheckout`), the tracked folders it can be chosen among, the broker's preview and the experiment's
 * receipt (`window.dm.crossRepoCorrections`). Everything is read again after each request, on Check again and when the
 * workspace reloads, so the panel always shows the target as it stands now. One request at a time per experiment: a
 * second click while one is on its way (or after the panel remounted) is ignored, and the broker itself finds an
 * identical request again rather than writing it twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommandResult, TrackedFolderView } from '../../../shared/desktop/api'
import type { SourceCheckoutChoice, SourceCheckoutView } from '../../../shared/desktop/sourceCheckout'
import type { CrossRepoCorrectionLinkView, CrossRepoCorrectionPreview, CrossRepoCorrectionResult, CrossRepoWithdrawalView } from '../../../shared/domain/crossRepoCorrections'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import { errorMessage } from '../api/dm'
import {
  choiceOutcome,
  experimentLink,
  type MainAction,
  needsUnverifiedConfirmation,
  type OutcomeView,
  refusalOutcome,
  resultOutcome,
  withdrawalOutcome
} from './crossRepoView'

type PanelRead<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

export interface CrossRepoPanelState {
  checkout: SourceCheckoutView | null
  folders: TrackedFolderView[]
  preview: PanelRead<CrossRepoCorrectionPreview>
  link: CrossRepoCorrectionLinkView | null
  /** What is on its way, for the person; null when nothing is. */
  busy: string | null
  outcome: OutcomeView | null
  /** The key of a withdrawal refused only because the target cannot be checked: it waits for the person's confirmation. */
  unverifiedKey: string | null
  /** Creating a new epic (the target lost the one reached before) waits for the person's confirmation. */
  confirmRecreate: boolean
}

export interface CrossRepoPanelActions {
  refresh(): void
  pick(): void
  associate(path: string): void
  clear(): void
  run(action: NonNullable<MainAction>): void
  withdraw(key: string, confirmUnverified: boolean): void
  collect(key: string): void
  askRecreate(ask: boolean): void
  dismiss(): void
}

/** Requests on their way, by folder and experiment: kept outside React so a remounted panel sees them too. */
const inFlight = new Set<string>()

interface Target {
  folder: string
  reportId: string
  experimentId: string
  /** Tells the shell the target folder changed (null where it cannot). */
  folderChanged?: ((folderPath: string) => void) | null
}

const INITIAL: CrossRepoPanelState = { checkout: null, folders: [], preview: { status: 'loading' }, link: null, busy: null, outcome: null, unverifiedKey: null, confirmRecreate: false }

async function settled<T>(call: Promise<CommandResult<T>>): Promise<CommandResult<T>> {
  try {
    return await call
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: errorMessage(error) } }
  }
}

/** Everything the panel shows, read now. */
async function readAll(target: Target): Promise<Pick<CrossRepoPanelState, 'checkout' | 'folders' | 'preview' | 'link'>> {
  const { folder, reportId, experimentId } = target
  const api = window.dm.crossRepoCorrections
  const [checkout, folders, preview, links] = await Promise.all([
    window.dm.sourceCheckout.get().catch(() => null),
    window.dm.listFolders().catch(() => [] as TrackedFolderView[]),
    settled(api.preview(folder, { reportId, experimentId })),
    settled(api.list(folder, { experimentId }))
  ])
  const read: PanelRead<CrossRepoCorrectionPreview> = preview.ok ? { status: 'ready', value: preview.data } : { status: 'error', message: preview.error.message }
  const key = preview.ok ? preview.data.key : null
  return { checkout, folders, preview: read, link: links.ok ? experimentLink(links.data, key) : null }
}

type Patch = Partial<CrossRepoPanelState>

/** A broker answer as the outcome the panel shows. */
function answered<T>(answer: CommandResult<T>, what: string, view: (data: T) => OutcomeView): Patch {
  return { outcome: answer.ok ? view(answer.data) : refusalOutcome(answer.error, what) }
}

function withdrawn(answer: CommandResult<CrossRepoWithdrawalView>, key: string): Patch {
  if (!answer.ok && needsUnverifiedConfirmation(answer.error)) return { unverifiedKey: key, outcome: refusalOutcome(answer.error, 'Withdrawal') }
  return { unverifiedKey: null, ...answered(answer, 'Withdrawal', withdrawalOutcome) }
}

function chosen(choice: SourceCheckoutChoice | DomainErrorShape): Patch {
  if ('code' in choice) return { outcome: refusalOutcome(choice, 'Choosing the checkout') }
  return { outcome: choiceOutcome(choice) }
}

async function choose(call: () => Promise<SourceCheckoutChoice>): Promise<Patch> {
  try {
    return chosen(await call())
  } catch (error) {
    return chosen({ code: 'unauthorized', message: errorMessage(error) })
  }
}

/**
 * Create, recreate or retry. A request that reached the target tells the shell, so the target folder's sidebar lists
 * the epic at once (its own event feed would only catch up later).
 */
function mainRequest(target: Target, preview: CrossRepoCorrectionPreview, action: NonNullable<MainAction>): Promise<Patch> {
  const api = window.dm.crossRepoCorrections
  const { folder, reportId, experimentId } = target
  const told = (answer: CommandResult<CrossRepoCorrectionResult>): CommandResult<CrossRepoCorrectionResult> => {
    if (answer.ok && answer.data.target !== null && preview.target.path !== null) target.folderChanged?.(preview.target.path)
    return answer
  }
  if (action.kind === 'retry') return settled(api.retry(folder, preview.key ?? '')).then(told).then((answer) => answered(answer, 'Retry', resultOutcome))
  const input = { reportId, experimentId, expectedTargetProjectId: preview.target.projectId ?? '', recreate: action.kind === 'recreate' }
  return settled(api.create(folder, input)).then(told).then((answer) => ({ confirmRecreate: false, ...answered(answer, 'Creating it', resultOutcome) }))
}

export function useCrossRepoCorrection(target: Target, version: number | string): [CrossRepoPanelState, CrossRepoPanelActions] {
  const [state, setState] = useState<CrossRepoPanelState>(INITIAL)
  const seq = useRef(0)
  const targetRef = useRef(target)
  targetRef.current = target
  const stateRef = useRef(state)
  stateRef.current = state
  const reload = useCallback(async () => {
    const mine = ++seq.current
    const read = await readAll(targetRef.current)
    if (mine === seq.current) setState((now) => ({ ...now, ...read }))
  }, [])
  const { folder, reportId, experimentId } = target
  useEffect(() => {
    void reload()
  }, [reload, folder, reportId, experimentId, version])
  const request = useCallback(
    (label: string, work: () => Promise<Patch>) => {
      const key = `${targetRef.current.folder}\n${targetRef.current.experimentId}`
      if (inFlight.has(key)) return
      inFlight.add(key)
      setState((now) => ({ ...now, busy: label }))
      void work()
        .catch((error: unknown): Patch => ({ outcome: refusalOutcome({ code: 'internal', message: errorMessage(error) }, label.replace(/…$/, '')) }))
        .then(async (patch) => {
          setState((now) => ({ ...now, ...patch }))
          await reload()
        })
        .finally(() => {
          inFlight.delete(key)
          setState((now) => ({ ...now, busy: null }))
        })
    },
    [reload]
  )
  return [state, panelActions(stateRef, targetRef, { request, setState })]
}

interface Plumbing {
  request(label: string, work: () => Promise<Patch>): void
  setState: (update: (now: CrossRepoPanelState) => CrossRepoPanelState) => void
}

function panelActions(stateRef: { current: CrossRepoPanelState }, targetRef: { current: Target }, { request, setState }: Plumbing): CrossRepoPanelActions {
  const api = window.dm.crossRepoCorrections
  const folder = (): string => targetRef.current.folder
  return {
    refresh: () => request('Checking again…', () => Promise.resolve({})),
    pick: () => request('Choosing the checkout…', () => choose(() => window.dm.sourceCheckout.pick())),
    associate: (path) => request('Choosing the checkout…', () => choose(() => window.dm.sourceCheckout.associate(path))),
    clear: () =>
      request('Forgetting the choice…', async () => {
        await window.dm.sourceCheckout.clear()
        return { outcome: { heading: 'The checkout choice was forgotten (the folder and its data stay as they are).', tone: 'neutral', lines: [], retryable: null } }
      }),
    run: (action) => {
      const preview = stateRef.current.preview
      if (preview.status === 'ready') request(`${action.label}…`, () => mainRequest(targetRef.current, preview.value, action))
    },
    withdraw: (key, confirmUnverified) => request('Withdrawing…', () => settled(api.withdraw(folder(), { key, confirmUnverified })).then((answer) => withdrawn(answer, key))),
    collect: (key) => request('Bringing back its grades…', () => settled(api.collectResults(folder(), key)).then((answer) => answered(answer, 'Bringing back its grades', collectedOutcome))),
    askRecreate: (ask) => setState((now) => ({ ...now, confirmRecreate: ask })),
    dismiss: () => setState((now) => ({ ...now, outcome: null, unverifiedKey: null }))
  }
}

function collectedOutcome(link: CrossRepoCorrectionLinkView): OutcomeView {
  const grades = link.results?.grades.length ?? 0
  return { heading: `Brought back ${grades} grade(s) of "${link.results?.epicTitle ?? 'the correction epic'}"`, tone: 'accepted', lines: [], retryable: null }
}
