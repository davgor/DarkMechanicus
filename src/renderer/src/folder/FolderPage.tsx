import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { FOLDER_TABS } from '../app/folderTabs'
import type { FolderTab } from '../app/folderTabs'
import './folder.css'

const LABELS: Record<FolderTab, string> = { source: 'Source control', epics: 'Epics' }

interface FolderPageProps {
  folder: TrackedFolderView
  tab: FolderTab
  onTab(tab: FolderTab): void
  /** The panel of the chosen tab. */
  children: ReactNode
}

/** The tab an arrow, Home or End key moves to, or null for any other key. */
function targetTab(key: string, current: FolderTab): FolderTab | null {
  const index = FOLDER_TABS.indexOf(current)
  const count = FOLDER_TABS.length
  const targets: Record<string, number> = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }
  const target = Object.hasOwn(targets, key) ? targets[key] : undefined
  return target === undefined ? null : (FOLDER_TABS[target] ?? null)
}

/** A folder's page: its header, the Source control and Epics tabs, and the panel of the chosen one. */
export function FolderPage({ folder, tab, onTab, children }: FolderPageProps): JSX.Element {
  const id = useId()
  const strip = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = targetTab(event.key, tab)
    if (next === null) {
      return
    }
    event.preventDefault()
    onTab(next)
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
  }
  return (
    <div className="folder-page">
      <header className="folder-header">
        <span className="eyebrow">FOLDER</span>
        <h1 className="display">{folder.name}</h1>
        <span className="mono muted">{folder.displayPath}</span>
      </header>
      <div ref={strip} className="tp-tabs folder-tabs" role="tablist" aria-label="Folder sections" onKeyDown={onKeyDown}>
        {FOLDER_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            data-tab={name}
            aria-selected={tab === name}
            aria-controls={`${id}-panel`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => onTab(name)}
          >
            {LABELS[name]}
          </button>
        ))}
      </div>
      <div className="folder-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
        {children}
      </div>
    </div>
  )
}
