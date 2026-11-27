import { useId, useState } from 'react'
import { ARCHETYPE_INFO, WORKER_TYPE_INFO } from '../../../shared/cults/archetypes'
import type { CultMemberDetail, CultRunDetail } from '../../../shared/cults/cultApi'
import type { CultView } from '../../../shared/cults/cult'
import { formatDuration } from '../../../shared/cults/duration'
import { remainingMs, type EndReason } from '../../../shared/cults/runState'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { FoundCultDialog } from '../cults/FoundCultDialog'
import { useCults, type CultEntry, type CultsModel } from '../cults/useCults'
import { useNow } from '../epic/clock'
import { SidebarSection } from './SidebarSection'
import '../cults/cults.css'

/** The run's state as the sidebar dot says it. */
type CultDot = 'idle' | 'running' | 'paused' | 'ending'

/** A member's live activity, published by the supervisor with each snapshot (DM-666); absent before it lands. */
type Member = CultMemberDetail & { activity?: { working: boolean } | null }

interface CultsSectionProps {
  folders: readonly TrackedFolderView[]
  /** The cult whose page is open in the main area. */
  selectedCultId: string | null
  onSelectCult(cultId: string): void
  /** Opens a member's terminal (the Magos's chat), which lives in its run's work folder. */
  onOpenChat(folder: string, chatId: string): void
}

type Pending = { kind: 'found' } | { kind: 'edit'; cult: CultView } | { kind: 'delete'; entry: CultEntry }

const END_TEXT: Readonly<Record<EndReason, string>> = {
  completed: 'completed',
  expired: 'time ran out',
  stopped: 'stopped',
  killed: 'killed',
  interrupted: 'interrupted',
  failed: 'failed'
}

const activeRun = (entry: CultEntry): CultRunDetail | null => entry.runs.find((run) => run.run.state !== 'ended') ?? null

function dotOf(run: CultRunDetail | null): CultDot {
  if (run === null) return 'idle'
  if (run.run.state === 'paused') return 'paused'
  return run.run.state === 'shutting_down' ? 'ending' : 'running'
}

/** The live time left on an active run, or "unlimited". */
function Remaining({ run }: { run: CultRunDetail }): JSX.Element {
  const now = useNow()
  const left = remainingMs(run.run, new Date(now).toISOString())
  return <span className="mono cult-remaining">{left === null ? 'unlimited' : `${formatDuration(Math.ceil(left / 60_000) * 60_000)} left`}</span>
}

/** What kind of worker a member is: its slot's type, or the run type its Magos created. */
function workerTypeOf(member: Member, run: CultRunDetail): string | null {
  if (member.workerType !== null) return WORKER_TYPE_INFO[member.workerType].displayName
  return run.workerTypes.find((type) => type.id === member.runWorkerTypeId)?.displayName ?? null
}

function AcolyteRow({ member, run }: { member: Member; run: CultRunDetail }): JSX.Element {
  const reasonId = useId()
  const working = member.activity?.working === true
  const type = workerTypeOf(member, run)
  return (
    <li className="cult-member" aria-describedby={member.tierReason === null ? undefined : reasonId}>
      <span className="cult-member-head">
        <span className="cult-member-name" title={member.displayName}>{member.displayName}</span>
        <span className="badge cult-watch" title="Its terminal is watch-only">watch only</span>
      </span>
      <span className="cult-member-meta">
        <span className={classNames('cult-activity', working && 'is-working')}>{working ? 'working' : 'idle'}</span>
        {type === null ? null : <span>{type}</span>}
        {member.model === null ? null : <span className="mono">{member.model}</span>}
        {member.tier === null ? null : <span className="badge cult-tier">{member.tier}</span>}
      </span>
      {member.tierReason === null ? null : <span id={reasonId} className="sr-only">{`Tier reason: ${member.tierReason}`}</span>}
    </li>
  )
}

function PastRuns({ runs }: { runs: CultRunDetail[] }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (runs.length === 0) return null
  return (
    <div className="cult-past">
      <button type="button" className="cult-past-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {`Past runs (${runs.length})`}
      </button>
      {open ? (
        <ul className="cult-past-list" aria-label="Past runs">
          {runs.map(({ run }) => (
            <li key={run.id}>
              <span className="mono">{new Date(run.startedAt).toLocaleString()}</span>
              <span>{run.endReason === null ? 'ended' : END_TEXT[run.endReason]}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function RunMembers({ run, onOpenChat }: { run: CultRunDetail; onOpenChat(folder: string, chatId: string): void }): JSX.Element {
  const live = (run.members as Member[]).filter((member) => member.leftAt === null)
  const magos = live.find((member) => member.role === 'magos')
  const acolytes = live.filter((member) => member.role === 'acolyte')
  return (
    <ul className="cult-members" aria-label="Members">
      {magos === undefined ? null : (
        <li>
          <button type="button" className="cult-member cult-magos" onClick={() => onOpenChat(run.run.workDir, magos.chatId)}>
            <span className="cult-member-name">{magos.displayName}</span>
            <span className="cult-member-meta">
              <span>Magos</span>
              {magos.model === null ? null : <span className="mono">{magos.model}</span>}
            </span>
          </button>
        </li>
      )}
      {acolytes.map((member) => <AcolyteRow key={member.chatId} member={member} run={run} />)}
      {acolytes.length === 0 ? <li className="sidebar-note">No acolytes yet.</li> : null}
    </ul>
  )
}

interface CultRowProps {
  entry: CultEntry
  selected: boolean
  onSelect(): void
  onOpenChat(folder: string, chatId: string): void
  onAsk(pending: Pending): void
}

function CultRow({ entry, selected, onSelect, onOpenChat, onAsk }: CultRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { cult } = entry
  const run = activeRun(entry)
  const dot = dotOf(run)
  return (
    <li>
      <div className="agent-row-line">
        <button type="button" className="agent-chats-toggle" aria-expanded={expanded} aria-label={`Runs of ${cult.name}`} onClick={() => setExpanded(!expanded)}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        </button>
        <button type="button" className={classNames('agent-row', 'cult-row', selected && 'is-selected')} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
          <span className="agent-text">
            <span className="agent-name">{cult.name}</span>
            <span className="agent-meta">
              <span>{ARCHETYPE_INFO[cult.archetype].displayName}</span>
              <span className={`agent-state cult-dot-${dot}`}>
                <span className="agent-state-dot" aria-hidden="true" />
                {dot}
              </span>
              {run === null ? null : <Remaining run={run} />}
            </span>
          </span>
        </button>
        <Menu label={`Actions for ${cult.name}`} open={menuOpen} onOpenChange={setMenuOpen}
          items={[
            { id: 'edit', label: 'Edit', onSelect: () => onAsk({ kind: 'edit', cult }) },
            { id: 'delete', label: 'Delete', onSelect: () => onAsk({ kind: 'delete', entry }) }
          ]} />
      </div>
      {expanded ? (
        <div className="cult-expanded">
          {run === null ? <p className="sidebar-note">No active run.</p> : <RunMembers run={run} onOpenChat={onOpenChat} />}
          <PastRuns runs={entry.runs.filter((candidate) => candidate.run.state === 'ended')} />
        </div>
      ) : null}
    </li>
  )
}

function DeleteCultDialog({ entry, onConfirm, onClose }: { entry: CultEntry; onConfirm(): Promise<string | null>; onClose(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const active = activeRun(entry) !== null
  const confirm = async (): Promise<void> => {
    setBusy(true)
    const refused = await onConfirm()
    setBusy(false)
    if (refused === null) onClose()
    else setRefusal(refused)
  }
  return (
    <Dialog title="Delete this cult?"
      description={`${active ? 'Its running cult is ended first: the Magos and acolytes are stopped. ' : ''}This removes the cult, its runs and its member chats from this computer. It cannot be undone.`}
      onClose={onClose}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" busy={busy} onClick={() => void confirm()}>Delete cult</Button>
      </>}>
      <p className="dialog-path">{entry.cult.name}</p>
      {refusal === null ? null : <p role="alert" className="form-error">{refusal}</p>}
    </Dialog>
  )
}

function PendingDialog({ pending, model, folders, onClose }: { pending: Pending; model: CultsModel; folders: readonly TrackedFolderView[]; onClose(): void }): JSX.Element {
  if (pending.kind === 'delete') return <DeleteCultDialog entry={pending.entry} onConfirm={() => model.remove(pending.entry.cult.id)} onClose={onClose} />
  if (pending.kind === 'edit') {
    const { cult } = pending
    return <FoundCultDialog folders={folders} cult={cult} onSubmit={(input) => model.update(cult.id, input)} onClose={onClose} />
  }
  return <FoundCultDialog folders={folders} onSubmit={model.create} onClose={onClose} />
}

function CultList({ model, props, onAsk }: { model: CultsModel; props: CultsSectionProps; onAsk(pending: Pending): void }): JSX.Element {
  const { state } = model
  if (state.status === 'loading') return <p className="sidebar-note">Loading cults…</p>
  if (state.status === 'error') return <p className="sidebar-note is-error">{`Could not load cults: ${state.message}`}</p>
  if (state.cults.length === 0) return <p className="sidebar-note">No cults yet. Use + to found one.</p>
  return (
    <ul className="agent-list cult-list">
      {state.cults.map((entry) => (
        <CultRow key={entry.cult.id} entry={entry} selected={props.selectedCultId === entry.cult.id}
          onSelect={() => props.onSelectCult(entry.cult.id)} onOpenChat={props.onOpenChat} onAsk={onAsk} />
      ))}
    </ul>
  )
}

/** The cults below the agents: each with its live state and time left, expandable to its run's members and past runs. */
export function CultsSection(props: CultsSectionProps): JSX.Element {
  const model = useCults()
  const [pending, setPending] = useState<Pending | null>(null)
  return (
    <SidebarSection title="Cults" className="sidebar-cults" action={<Button variant="ghost" icon="plus" aria-label="Found a cult" onClick={() => setPending({ kind: 'found' })} />}>
      <CultList model={model} props={props} onAsk={setPending} />
      {pending === null ? null : <PendingDialog pending={pending} model={model} folders={props.folders} onClose={() => setPending(null)} />}
    </SidebarSection>
  )
}
