import { useEffect, useState } from 'react'
import type { ModelOption } from '../../../shared/agents/chat'
import type { AgentKind } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'

/**
 * The models an agent offers, as the new-chat flow needs to know them. `unsupported` is an agent
 * this version cannot run chats with yet; `failed` is a list that could not be read.
 */
export type ModelsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; models: ModelOption[] }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string }

interface Loaded {
  kind: AgentKind
  state: ModelsState
}

async function fetchModels(kind: AgentKind): Promise<ModelsState> {
  try {
    const result = await window.dm.chats.models(kind)
    if (result.ok) {
      return { status: 'ready', models: result.data }
    }
    return result.error.code === 'unsupported_capability'
      ? { status: 'unsupported' }
      : { status: 'failed', message: result.error.message }
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) }
  }
}

/** Asks for the models of `kind` whenever it changes; an answer for a kind that is no longer chosen is dropped. */
export function useAgentModels(kind: AgentKind | null): ModelsState {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    if (kind === null) {
      return undefined
    }
    let current = true
    void fetchModels(kind).then((state) => {
      if (current) setLoaded({ kind, state })
    })
    return () => {
      current = false
    }
  }, [kind])
  if (kind === null) {
    return { status: 'idle' }
  }
  return loaded !== null && loaded.kind === kind ? loaded.state : { status: 'loading' }
}
