/**
 * The transcript a chat stored before chats became terminals, readable read-only above its terminal
 * (`docs/design/chat-shells.md`, "Existing chats and their transcripts"). The chat's stored items are read the way
 * the panels that follow a chat read them (`window.dm.chats.read`: no agent started, nothing stored), once per chat
 * shown; a chat with none, or whose transcript cannot be read, shows nothing. **Earlier conversation** opens them in
 * `ChatTranscript`, with nothing to send or answer: main reports an approval request no decision was stored for as
 * cancelled, since no agent waits on it. Nothing is ever appended to the transcript from here.
 */
import { useEffect, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import { Button } from '../components/Button'
import { ChatTranscript } from './ChatTranscript'
import { applyItem, type TranscriptEntry } from './chatViewModel'

interface Stored {
  chatId: string
  entries: TranscriptEntry[]
}

/** The control and, once opened, the read-only transcript; nothing for a chat that stored none. */
export function EarlierConversation({ folder, chat, agentName }: { folder: string; chat: ChatRecord; agentName: string }): JSX.Element | null {
  const [stored, setStored] = useState<Stored | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let current = true
    setOpen(false)
    window.dm.chats.read({ folder, chatId: chat.id }).then(
      (result) => {
        if (current) setStored(result.ok && result.data.items.length > 0 ? { chatId: chat.id, entries: result.data.items.reduce<TranscriptEntry[]>(applyItem, []) } : null)
      },
      () => {
        if (current) setStored(null)
      }
    )
    return () => {
      current = false
    }
  }, [folder, chat.id])
  if (stored?.chatId !== chat.id) {
    return null
  }
  return (
    <>
      <div className="terminal-earlier">
        <Button size="sm" icon={open ? 'chevron-down' : 'chevron-right'} aria-expanded={open} onClick={() => setOpen(!open)}>
          Earlier conversation
        </Button>
        <span className="terminal-earlier-note">Read-only: what this chat said before it ran in a terminal.</span>
      </div>
      {open ? (
        <section className="terminal-earlier-panel" aria-label="Earlier conversation">
          <ChatTranscript agentName={agentName} folder={folder} entries={stored.entries} />
        </section>
      ) : null}
    </>
  )
}
