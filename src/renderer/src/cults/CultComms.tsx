/**
 * The comms pane at the Cult page's right: tabs for the Magos's interactive terminal (the default), the run's Pipeline
 * (`PipelinePanel`, live) and one closable, watch-only terminal per acolyte opened from the inspector. A
 * member's chat is read in its run's work folder, a tracked folder or a project-less cult's sanctum, which main resolves
 * for both, and its terminal is attached there through the same terminal IPC every chat uses.
 */
import { useRef, type KeyboardEvent } from 'react'
import type { CultMemberDetail, CultRunDetail } from '../../../shared/cults/cultApi'
import type { Scheduler } from '../app/scheduler'
import { TerminalPane } from '../agents/TerminalPane'
import type { TerminalKit } from '../agents/terminalView'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { PipelinePanel } from './PipelinePanel'
import { useMemberChat } from './useCultPage'

/** The comms tab shown: the Magos's, the Pipeline, or a watched acolyte's by its chat id. */
export type CommsTab = { kind: 'magos' } | { kind: 'pipeline' } | { kind: 'watch'; chatId: string }

interface CommsProps {
  run: CultRunDetail | null
  /** The acolytes whose watch tabs are open, in the order opened. */
  watched: readonly CultMemberDetail[]
  tab: CommsTab
  onTab(tab: CommsTab): void
  onCloseWatch(chatId: string): void
  agentName: string
  kit: TerminalKit
  scheduler: Scheduler
}

const tabKey = (tab: CommsTab): string => (tab.kind === 'watch' ? `watch:${tab.chatId}` : tab.kind)

/** Left and Right move between the tabs, as a tab list does. */
function arrowTo(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const tabs = [...(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
  const at = tabs.indexOf(event.target as HTMLElement)
  if (at < 0) return
  const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
  next?.focus()
  next?.click()
}

export function CultComms({ run, watched, tab, onTab, onCloseWatch, agentName, kit, scheduler }: CommsProps): JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const magos = run?.members.find((member) => member.role === 'magos' && member.leftAt === null) ?? null
  const tabs: { tab: CommsTab; label: string; member?: CultMemberDetail }[] = [
    { tab: { kind: 'magos' }, label: magos?.displayName ?? 'Magos' },
    { tab: { kind: 'pipeline' }, label: 'Pipeline' },
    ...watched.map((member) => ({ tab: { kind: 'watch' as const, chatId: member.chatId }, label: member.displayName, member }))
  ]
  const shown = tabKey(tab)
  return (
    <section className="cult-comms" aria-label="Comms">
      <div ref={list} className="cult-comms-tabs" role="tablist" aria-label="Comms channels" onKeyDown={(event) => arrowTo(event, list.current)}>
        {tabs.map((entry) => {
          const key = tabKey(entry.tab)
          return (
            <span key={key} className={classNames('cult-comms-tab', key === shown && 'is-active')}>
              <button type="button" role="tab" id={`cult-tab-${key}`} aria-selected={key === shown} tabIndex={key === shown ? 0 : -1}
                onClick={() => onTab(entry.tab)}>
                {entry.label}
                {entry.member === undefined ? null : <span className="badge cult-watch">watch only</span>}
              </button>
              {entry.member === undefined ? null : (
                <Button size="sm" variant="ghost" icon="close" aria-label={`Close ${entry.label}`} onClick={() => onCloseWatch(entry.member!.chatId)} />
              )}
            </span>
          )
        })}
      </div>
      <div className="cult-comms-body" role="tabpanel" aria-labelledby={`cult-tab-${shown}`}>
        <CommsBody run={run} magos={magos} tab={tab} agentName={agentName} kit={kit} scheduler={scheduler} />
      </div>
    </section>
  )
}

interface BodyProps {
  run: CultRunDetail | null
  magos: CultMemberDetail | null
  tab: CommsTab
  agentName: string
  kit: TerminalKit
  scheduler: Scheduler
}

function CommsBody({ run, magos, tab, agentName, kit, scheduler }: BodyProps): JSX.Element {
  if (run === null) {
    return <p className="cult-empty-note">{tab.kind === 'pipeline' ? 'Start the cult to see its pipeline.' : 'Start the cult to talk to its Magos.'}</p>
  }
  if (tab.kind === 'pipeline') return <div className="cult-pipeline-slot" data-slot="pipeline"><PipelinePanel run={run} live={scheduler} /></div>
  const chatId = tab.kind === 'watch' ? tab.chatId : magos?.chatId
  if (chatId === undefined) return <p className="cult-empty-note">The Magos has not joined yet.</p>
  return <MemberTerminal key={chatId} folder={run.run.workDir} chatId={chatId} watchOnly={tab.kind === 'watch'} agentName={agentName} kit={kit} scheduler={scheduler} />
}

interface MemberTerminalProps {
  /** The run's work folder, where its member chats live. */
  folder: string
  chatId: string
  watchOnly: boolean
  agentName: string
  kit: TerminalKit
  scheduler: Scheduler
}

/** A member's terminal: the Magos's interactive one, or an acolyte's watch-only one, headed by the member's name. */
function MemberTerminal({ folder, chatId, watchOnly, agentName, kit, scheduler }: MemberTerminalProps): JSX.Element {
  const chat = useMemberChat(folder, chatId)
  if (chat.status === 'loading') return <p className="cult-empty-note" role="status">Opening terminal…</p>
  if (chat.status === 'error') return <p className="cult-refusal" role="alert">{chat.message}</p>
  return <TerminalPane folder={chat.value.folder} chat={chat.value} agentName={agentName} kit={kit} scheduler={scheduler} readOnly={watchOnly} />
}
