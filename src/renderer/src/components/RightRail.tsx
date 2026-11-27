import { createContext, useContext, useId } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { RAIL_TAB_ORDER, useRailState } from './useRailState'
import type { RailStateHandle, RailTabId } from './useRailState'
import './rightRail.css'

export interface RailTab {
  id: RailTabId
  label: string
  icon: IconName
  badge?: { text: string; tone: 'attention' | 'running' | 'neutral' }
  content: ReactNode
}

/**
 * The rail remembers its own state under `storageKey`, or shows a `rail` state its caller owns, so a control
 * outside the rail (a chat's Agents toggle) reads and writes the same state as the rail's chevron.
 */
type RightRailProps = { label: string; tabs: RailTab[] } & ({ storageKey: string } | { rail: RailStateHandle })

const RailContext = createContext<RailStateHandle | null>(null)

function Badge({ badge }: { badge: RailTab['badge'] }): JSX.Element | null {
  return badge ? <span className={`rr-badge rr-badge-${badge.tone}`}>{badge.text}</span> : null
}

/** Keying the state owner prevents a mounted rail from copying one chat's memory into another. */
export function RightRail(props: RightRailProps): JSX.Element {
  if ('rail' in props) return <RailContents label={props.label} tabs={props.tabs} rail={props.rail} />
  return <StoredRail key={props.storageKey} label={props.label} tabs={props.tabs} storageKey={props.storageKey} />
}

function StoredRail({ label, tabs, storageKey }: { label: string; tabs: RailTab[]; storageKey: string }): JSX.Element {
  const rail = useRailState(storageKey)
  return <RailContents label={label} tabs={tabs} rail={rail} />
}

function RailContents({ label, tabs, rail }: { label: string; tabs: RailTab[]; rail: RailStateHandle }): JSX.Element {
  const { state, setCollapsed, setTab } = rail
  const id = useId()
  const ordered = RAIL_TAB_ORDER.flatMap((tabId) => tabs.filter((tab) => tab.id === tabId))
  const selected = ordered.find((tab) => tab.id === state.tab) ?? ordered[0]
  const expand = (tab: RailTabId): void => {
    setTab(tab)
    setCollapsed(false)
  }
  return (
    <RailContext.Provider value={rail}>
      <aside aria-label={label} className="rr" data-collapsed={state.collapsed}>
        {state.collapsed ? (
          <>
            <button type="button" className="rr-toggle" aria-label={`Expand ${label}`} aria-expanded="false" onClick={() => setCollapsed(false)}>
              <Icon name="chevron-right" />
            </button>
            {ordered.map((tab) => (
              <button key={tab.id} type="button" className="rr-strip-tab" aria-label={tab.badge ? `${tab.label}: ${tab.badge.text}` : tab.label} onClick={() => expand(tab.id)}>
                <Icon name={tab.icon} />
                <Badge badge={tab.badge} />
              </button>
            ))}
          </>
        ) : (
          <>
            <RailHeader label={label} id={id} ordered={ordered} selected={selected?.id} rail={rail} />
            {selected ? (
              <div role="tabpanel" id={`${id}-panel-${selected.id}`} aria-labelledby={`${id}-tab-${selected.id}`} className="rr-panel" tabIndex={0}>
                {selected.content}
              </div>
            ) : null}
          </>
        )}
      </aside>
    </RailContext.Provider>
  )
}

function RailHeader({ label, id, ordered, selected, rail }: {
  label: string
  id: string
  ordered: RailTab[]
  selected: RailTabId | undefined
  rail: RailStateHandle
}): JSX.Element {
  return (
    <header className="rr-header">
      <div role="tablist" aria-label={label} className="rr-tabs">
        {ordered.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${id}-tab-${tab.id}`}
            aria-label={tab.badge ? `${tab.label} ${tab.badge.text}` : tab.label}
            aria-selected={selected === tab.id}
            aria-controls={`${id}-panel-${tab.id}`}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => rail.setTab(tab.id)}
            onKeyDown={(event) => {
              let next: number
              if (event.key === 'ArrowRight') next = (index + 1) % ordered.length
              else if (event.key === 'ArrowLeft') next = (index + ordered.length - 1) % ordered.length
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = ordered.length - 1
              else return
              event.preventDefault()
              rail.setTab(ordered[next].id)
              document.getElementById(`${id}-tab-${ordered[next].id}`)?.focus()
            }}
          >
            <Icon name={tab.icon} />
            <span>{tab.label}</span>
            <Badge badge={tab.badge} />
          </button>
        ))}
      </div>
      <button type="button" className="rr-toggle" aria-label={`Collapse ${label}`} aria-expanded="true" onClick={() => rail.setCollapsed(true)}>
        <Icon name="chevron-right" className="rr-chevron-rotated" />
      </button>
    </header>
  )
}

export function RailCard({ id, title, count, children }: {
  id: string
  title: string
  count?: number
  children: ReactNode
}): JSX.Element {
  const rail = useContext(RailContext)
  const contentId = useId()
  if (!rail) throw new Error('RailCard must be rendered inside RightRail')
  const open = Object.hasOwn(rail.state.cards, id) ? rail.state.cards[id] : true
  return (
    <section aria-label={title} className="rr-card">
      <button type="button" className="rr-card-heading" aria-label={count === undefined ? title : `${title} ${count}`} aria-expanded={open} aria-controls={contentId} onClick={() => rail.setCard(id, !open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span>{title}</span>
        {count !== undefined ? <span className="rr-badge rr-badge-neutral">{count}</span> : null}
      </button>
      <div id={contentId} className="rr-card-content" hidden={!open}>{children}</div>
    </section>
  )
}
