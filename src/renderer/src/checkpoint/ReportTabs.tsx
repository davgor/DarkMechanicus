import { createContext, type KeyboardEvent, type ReactNode, useContext, useId, useRef, useState } from 'react'

type ReportTab = 'report' | 'scorecard' | 'improvement'

const LABELS: Record<ReportTab, string> = { report: 'Report', scorecard: 'Scorecard', improvement: 'Improvement' }

/** The tab an arrow, Home or End key moves to, or null for any other key. */
function targetTab(key: string, current: ReportTab, tabs: readonly ReportTab[]): ReportTab | null {
  const index = tabs.indexOf(current)
  const count = tabs.length
  const targets: Record<string, number> = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }
  const target = Object.hasOwn(targets, key) ? targets[key] : undefined
  return target === undefined ? null : (tabs[target] ?? null)
}

/** Opens another tab of the report from inside one (a section pointing at where it is reviewed); null outside tabs. */
const TabOpener = createContext<{ tabs: readonly ReportTab[]; open(tab: ReportTab): void } | null>(null)

export function useReportTabs(): { tabs: readonly ReportTab[]; open(tab: ReportTab): void } | null {
  return useContext(TabOpener)
}

/**
 * A sprint report's tabs, the same in the checkpoint review and in a completed epic's history: the report as written,
 * its Scorecard and, for a report with a retro, its Improvement chain (measured result, findings, experiments and the
 * corrective work they lead to). Only the open tab is rendered, so the scorecard and findings are read when the person
 * opens them. Tab reaches the open tab; the arrow keys, Home and End move between tabs and open them.
 */
export function ReportTabs(props: { label: string; report: ReactNode; scorecard: ReactNode; improvement?: ReactNode }): JSX.Element {
  const [tab, setTab] = useState<ReportTab>('report')
  const id = useId()
  const strip = useRef<HTMLDivElement>(null)
  const tabs: ReportTab[] = props.improvement === undefined ? ['report', 'scorecard'] : ['report', 'scorecard', 'improvement']
  const open = (next: ReportTab): void => {
    setTab(next)
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = targetTab(event.key, tab, tabs)
    if (next === null) {
      return
    }
    event.preventDefault()
    open(next)
  }
  const panels: Record<ReportTab, ReactNode> = { report: props.report, scorecard: props.scorecard, improvement: props.improvement }
  return (
    <TabOpener.Provider value={{ tabs, open }}>
      <div ref={strip} className="tp-tabs cp-tabs" role="tablist" aria-label={`${props.label} sections`} onKeyDown={onKeyDown}>
        {tabs.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            id={`${id}-tab-${entry}`}
            data-tab={entry}
            aria-selected={tab === entry}
            aria-controls={`${id}-panel`}
            tabIndex={tab === entry ? 0 : -1}
            onClick={() => setTab(entry)}
          >
            {LABELS[entry]}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="cp-tabpanel">
        {panels[tab]}
      </div>
    </TabOpener.Provider>
  )
}
