import { useEffect, useState } from 'react'
import type { AgentChatApi, AttentionItem } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'

type Attention = ReadonlyMap<string, readonly AttentionItem[]>

const EMPTY: Attention = new Map()

function withList(previous: Attention, chatId: string, items: readonly AttentionItem[]): Attention {
  const next = new Map(previous)
  if (items.length > 0) next.set(chatId, items)
  else next.delete(chatId)
  return next
}

/**
 * The folder's prompts waiting on the person or the Magos, by chat id. Subscribes before reading once: a push carries
 * a chat's whole list, so pushes that land while the read is in flight win over it. A refused or rejected read is
 * logged and counts as an empty list, so no badge shows until a push arrives. Unsubscribes on unmount.
 */
export function useNeedsYou(folder: string, api: AgentChatApi = window.dm.agentChat): Attention {
  const [view, setView] = useState<{ folder: string; api: AgentChatApi; attention: Attention }>(
    () => ({ folder, api, attention: EMPTY })
  )
  useEffect(() => {
    let live = true
    let loaded = false
    // A chat's latest push, kept even when empty so it clears that chat's entry in the read.
    const pushed = new Map<string, readonly AttentionItem[]>()
    const publish = (attention: Attention): void => { if (live) setView({ folder, api, attention }) }
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== 'attention' || event.folder !== folder) return
      if (loaded) setView((previous) => ({ folder, api, attention: withList(previous.attention, event.chatId, event.items) }))
      else pushed.set(event.chatId, event.items)
    })
    const settle = (result: CommandResult<AttentionItem[]> | null): void => {
      loaded = true
      if (!live) return
      const initial = new Map<string, AttentionItem[]>()
      if (result?.ok) for (const item of result.data) initial.set(item.chatId, [...(initial.get(item.chatId) ?? []), item])
      let attention: Attention = initial
      for (const [chatId, items] of pushed) attention = withList(attention, chatId, items)
      publish(attention)
    }
    void api.attention({ folder }).then((result) => {
      if (!result.ok) console.warn(`Needs-you read for ${folder} was refused: ${result.error.message}`)
      settle(result)
    }, (error: unknown) => {
      console.warn(`Needs-you read for ${folder} failed: ${error instanceof Error ? error.message : String(error)}`)
      settle(null)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [folder, api])
  return view.folder === folder && view.api === api ? view.attention : EMPTY
}
