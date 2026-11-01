import { useEffect, useState } from 'react'
import type { AgentId } from '../../../shared/desktop/api'

/** A folder's default agent as main stores it: `loaded` false until it is known. */
interface FolderDefaultAgent {
  agentId: AgentId | null
  loaded: boolean
}

/**
 * Reads a folder's default agent once per folder. A refusal (an untracked folder) or any other failure
 * reads as no default, so the dialogs keep their first choice instead of blocking on it.
 */
export function useFolderDefaultAgent(folderPath: string): FolderDefaultAgent {
  const [state, setState] = useState<FolderDefaultAgent & { folder: string | null }>({
    folder: null,
    agentId: null,
    loaded: false
  })
  useEffect(() => {
    let live = true
    const settle = (agentId: AgentId | null): void => {
      if (live) setState({ folder: folderPath, agentId, loaded: true })
    }
    window.dm.folderDefaultAgent(folderPath).then(settle, () => settle(null))
    return () => {
      live = false
    }
  }, [folderPath])
  return state.folder === folderPath ? { agentId: state.agentId, loaded: state.loaded } : { agentId: null, loaded: false }
}
