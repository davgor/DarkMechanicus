import { useLayoutEffect, useRef } from 'react'
import type { AgentTodoPhase, AgentTodoTask } from '../../../shared/agents/agentChat'
import { usePersistentState } from '../app/usePersistentState'
import { Icon, type IconName } from '../components/Icon'
import type { AgentChatState } from './agentChatModel'
import { activeTask, showsTodoCard, todoProgress } from './todoPanelModel'

export function isCollapsedMap(value: unknown): value is Record<string, boolean> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every((entry) => typeof entry === 'boolean')
}

export function scrollTopFor({ rowTop, rowHeight, viewport, scrollHeight }: {
  rowTop: number; rowHeight: number; viewport: number; scrollHeight: number
}): number {
  return Math.max(0, Math.min(Math.max(0, scrollHeight - viewport), rowTop - (viewport - rowHeight) / 3))
}

const empty: AgentTodoPhase[] = []
const glyphs: Record<AgentTodoTask['status'], IconName> = {
  pending: 'circle', in_progress: 'circle-dashed', completed: 'check', abandoned: 'close', blocked: 'pause'
}

function useActiveRowScroll(active: AgentTodoTask | null, collapsed: boolean, threadId: string, visible: boolean) {
  const list = useRef<HTMLDivElement>(null)
  const activeRow = useRef<HTMLLIElement>(null)
  useLayoutEffect(() => {
    const container = list.current
    const row = activeRow.current
    if (!container || !row) return
    container.scrollTop = scrollTopFor({
      rowTop: row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop,
      rowHeight: row.offsetHeight, viewport: container.clientHeight, scrollHeight: container.scrollHeight
    })
  }, [active, collapsed, threadId, visible])
  return { list, activeRow }
}

/** Visibility is derived from ordered model events, never from React render cadence. */
export function TodoCard({ chatId, state, threadId = '' }: {
  chatId: string; state: Pick<AgentChatState, 'todos' | 'todoMemory' | 'turn' | 'status'>; threadId?: string
}): JSX.Element | null {
  const [collapsedMap, setCollapsedMap] = usePersistentState('dm.todoCardCollapsed', {}, isCollapsedMap)
  const collapsed = collapsedMap[chatId] === true
  const busy = state.status === 'busy'
  const phases = state.todos.get(threadId) ?? empty
  const visible = showsTodoCard(state.todoMemory.get(threadId) ?? null, phases, state.turn, busy)
  const active = activeTask(phases)
  const { list, activeRow } = useActiveRowScroll(active, collapsed, threadId, visible)
  if (!visible) return null
  const progress = todoProgress(phases)
  return <section className="todo-card" aria-label="To-dos">
    <button type="button" className="todo-card-header" aria-expanded={!collapsed}
      onClick={() => setCollapsedMap((previous) => ({ ...previous, [chatId]: !collapsed }))}>
      <Icon name="list-checks" /><strong>To-dos</strong><span>{progress.closed}/{progress.total}</span>
      <progress className="todo-card-progress" aria-label="Closed tasks"
        value={progress.closed} max={progress.total}
        aria-valuenow={progress.closed} aria-valuemax={progress.total} />
      {collapsed && active && <span className="todo-card-active">{active.activeForm ?? active.content}</span>}
      <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
    </button>
    {!collapsed && <div className="todo-card-list" ref={list}>
      {phases.map((phase, phaseIndex) => {
        const count = todoProgress([phase])
        return <div key={phaseIndex}>
          {phases.length > 1 && <h3 className="todo-card-phase">{phase.name} <span>{count.closed}/{count.total}</span></h3>}
          <ul>{phase.tasks.map((task, taskIndex) => <li key={taskIndex}
            ref={task === active ? activeRow : undefined} className={`todo-card-row todo-card-${task.status}`}
            aria-current={task === active ? 'step' : undefined}>
            <span className={task.status === 'in_progress' && busy ? 'todo-card-spinner' : undefined}>
              <Icon name={glyphs[task.status]} /><span className="todo-card-sr">{task.status.replace('_', ' ')}</span>
            </span>
            <span><span className="todo-card-task">{task.content}</span>
              {task.status === 'blocked' && <span className="todo-card-blocker">Blocked on: {task.blocker}</span>}
            </span>
          </li>)}</ul>
        </div>
      })}
    </div>}
  </section>
}
