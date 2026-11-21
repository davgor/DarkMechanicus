import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { SidebarProps } from './Sidebar'
import { listFor } from '../app/useEpicLists'
import { groupEpics } from './buckets'
import { EpicRow } from './EpicRow'
import { Icon } from '../components/Icon'

export function ForgeRow({ folder, sidebar }: { folder: TrackedFolderView; sidebar: SidebarProps }): JSX.Element {
  const children = sidebar.folders.filter(f => f.forgeParent === folder.path)
  const expanded = sidebar.expansion.isFolderExpanded(folder.path)
  const agents = sidebar.agentChats.list.chats.filter(chat => !chat.archived)
  return <div className="folder">
    <div className="folder-row">
      <button className="folder-chevron" aria-label={expanded ? 'Collapse ' + folder.name : 'Expand ' + folder.name} aria-expanded={expanded} onClick={() => sidebar.expansion.toggleFolder(folder.path)}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} /></button>
      <button className="folder-main" onClick={() => sidebar.onSelectFolder(folder.path)}><Icon name="folder" />{folder.name}</button>
    </div>
    {expanded && <div className="buckets">
      {['In progress', 'Backlog', 'Kanban', 'Completed'].map(label => <details key={label}>
        <summary className="bucket-header">{label}</summary>
        {children.map(child => {
          if (label === 'Kanban') return <button className="epic-row" key={child.path} onClick={() => sidebar.onSelectKanban(child.path)}>{child.name}</button>
          const bucket = groupEpics(listFor(sidebar.lists, child.path).epics).find(b => b.label === label)
          return <details key={child.path} className="bucket"><summary>{child.name} ({bucket?.count ?? 0})</summary>
            {bucket?.epics.map(epic => <EpicRow key={epic.id} epic={epic} selected={sidebar.selection.folderPath === child.path && sidebar.selection.epicId === epic.id} onOpen={id => sidebar.onSelectEpic(child.path, id)} />)}
          </details>
        })}
      </details>)}
      <details><summary className="bucket-header">Agents</summary>
        {agents.map(chat => <button key={chat.id} className="chat-row-main" onClick={() => sidebar.agentChats.onOpen(chat)}>
          {chat.title}{chat.targetRepository && <small className="chat-row-place">{chat.targetRepository}</small>}
        </button>)}
      </details>
    </div>}
  </div>
}
