/**
 * The files the selected agent touched through its file tools, under the epic's agent tree. Each in-folder row opens
 * the folder's Source control at that file; a file outside the folder is listed but has no action.
 */
import { useMemo, type ReactNode } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import { usePersistentState } from '../app/usePersistentState'
import { Icon } from '../components/Icon'
import { splitPath } from '../source/changeBadge'
import { agentChanges, type Change as Row } from './agentChanges'
import { isCollapsedMap } from './TodoCard'
import { useAgentChat } from './useAgentChat'

interface CardProps {
  folder: string
  epicId: string
  /** The selected root chat, or the chat that owns the selected thread. */
  chat: Pick<ChatRecord, 'id' | 'surface'>
  threadId: string | null
  onOpenSourceFile(absolutePath: string): void
}

const BADGES: Record<Row['kind'], { letter: string; label: string }> = {
  written: { letter: 'W', label: 'Written' },
  edited: { letter: 'E', label: 'Edited' }
}

/** The card's frame: a header that collapses it, remembered per folder and epic. */
function CardFrame({ folder, epicId, summary, children }: {
  folder: string
  epicId: string
  summary: string
  children: ReactNode
}): JSX.Element {
  const [collapsedMap, setCollapsedMap] = usePersistentState('dm.changesCardCollapsed', {}, isCollapsedMap)
  const key = `${folder}\n${epicId}`
  const collapsed = collapsedMap[key] === true
  return (
    <section className="acc" aria-label="Changes">
      <button type="button" className="acc-header" aria-expanded={!collapsed}
        onClick={() => setCollapsedMap((previous) => ({ ...previous, [key]: !collapsed }))}>
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
        <span className="acc-summary">{summary}</span>
      </button>
      {!collapsed && children}
    </section>
  )
}

function RowContent({ row }: { row: Row }): JSX.Element {
  const { dir, name } = splitPath(row.path)
  const badge = BADGES[row.kind]
  return (
    <>
      <span className="acc-path" title={row.path}><span className="acc-dir">{dir}</span><span>{name}</span></span>
      <span className="acc-badge" title={badge.label} aria-label={badge.label}>{badge.letter}</span>
      <span className="acc-tool" title={row.tool}>{row.tool}</span>
      {row.count > 1 && <span className="acc-count">×{row.count}</span>}
    </>
  )
}

function ChangeRow({ row, onOpenSourceFile }: { row: Row; onOpenSourceFile(absolutePath: string): void }): JSX.Element {
  if (row.inFolder) {
    return (
      <li>
        <button type="button" className="acc-row" onClick={() => onOpenSourceFile(row.absolutePath)}>
          <RowContent row={row} />
        </button>
      </li>
    )
  }
  return (
    <li className="acc-row acc-outside">
      <RowContent row={row} />
      <span className="acc-note">outside this folder</span>
    </li>
  )
}

/** Reads the chat without starting it: the chat view owns starting, the card only looks. */
function GuiChanges({ folder, epicId, chat, threadId, onOpenSourceFile }: CardProps): JSX.Element {
  const { state } = useAgentChat({ folder, chatId: chat.id }, { autoStart: false })
  const rows = useMemo(
    () => agentChanges(state.items, threadId === null ? { kind: 'chat' } : { kind: 'thread', threadId }, folder),
    [state.items, threadId, folder]
  )
  return (
    <CardFrame folder={folder} epicId={epicId}
      summary={rows.length === 0 ? 'No file changes yet' : `Changes · ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`}>
      {rows.length > 0 && (
        <ul className="acc-list">
          {rows.map((row) => <ChangeRow key={row.absolutePath} row={row} onOpenSourceFile={onOpenSourceFile} />)}
        </ul>
      )}
      <p className="acc-footer">Edits made through shell commands are not listed.</p>
    </CardFrame>
  )
}

/** A chat with no surface is a legacy terminal chat, as main treats it. */
export function AgentChangesCard(props: CardProps): JSX.Element {
  if (props.chat.surface !== 'gui') {
    return (
      <CardFrame folder={props.folder} epicId={props.epicId} summary="Changes">
        <p className="acc-footer">Not available for terminal chats</p>
      </CardFrame>
    )
  }
  return <GuiChanges {...props} />
}
