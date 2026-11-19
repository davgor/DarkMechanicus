import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationStateResult, ConversationTarget, SendConversationResult } from '../../../shared/agents/chatApi'
import { errorMessage } from '../api/dm'
import { AttachmentGallery } from '../attachments/AttachmentGallery'
import { type FormImage, ImageAttachField } from '../attachments/ImageAttachField'
import { unwrapChat } from '../agents/chatCalls'
import { bindRunner } from '../epic/runner'
import { Markdown } from '../markdown/Markdown'
import {
  agentLine,
  canSubmitComment,
  conversationItems,
  type ConversationMessage,
  MAX_COMMENT_LENGTH
} from './conversationView'
import './conversation.css'

export interface ConversationPanelProps {
  folderPath: string
  target: ConversationTarget
  messages(): Promise<readonly ConversationMessage[]>
  reloadKey: unknown
  canSend: boolean
  folderKey: string
  onOpenChat(chatId: string): void
}

interface LoadedConversation {
  messages: readonly ConversationMessage[] | null
  state: ConversationStateResult | null
  error: string | null
}

function targetKey(target: ConversationTarget): string {
  return 'cardId' in target ? `card:${target.cardId}` : `epic:${target.epicId}:ticket:${target.ticketId ?? ''}`
}

function useConversation(props: ConversationPanelProps, refresh: number): LoadedConversation {
  const loader = useRef(props.messages)
  const target = useRef(props.target)
  loader.current = props.messages
  target.current = props.target
  const key = targetKey(props.target)
  const [loaded, setLoaded] = useState<LoadedConversation>({ messages: null, state: null, error: null })

  useEffect(() => {
    let active = true
    setLoaded((held) => ({ ...held, error: null }))
    const load = async (): Promise<void> => {
      try {
        const messages = await loader.current()
        const state = await unwrapChat(
          window.dm.chats.conversationState({ folder: props.folderPath, target: target.current, messageIds: messages.map((message) => message.id) })
        )
        if (active) setLoaded({ messages, state, error: null })
      } catch (failure: unknown) {
        if (active) setLoaded({ messages: null, state: null, error: errorMessage(failure) })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [props.folderPath, props.reloadKey, key, refresh])

  return loaded
}

function Thread(props: { loaded: LoadedConversation; folderKey: string }): JSX.Element {
  if (props.loaded.error !== null) return <p role="alert" className="conversation-error">{props.loaded.error}</p>
  if (props.loaded.messages === null || props.loaded.state === null) return <p className="ew-muted">Loading conversation…</p>
  if (props.loaded.messages.length === 0) return <p className="ew-muted">No messages yet.</p>
  return (
    <ol className="conversation-thread" aria-label="Conversation">
      {conversationItems(props.loaded.messages, props.loaded.state).map((item) => (
        <li key={item.id} className={`conversation-bubble${item.mine ? ' is-mine' : ''}`} aria-label={`Message from ${item.author}`}>
          <p className="conversation-meta">
            <strong>{item.author}</strong>
            <time dateTime={item.at} title={item.at}>{new Date(item.at).toLocaleString()}</time>
          </p>
          <Markdown source={item.body} className="conversation-body" />
          {item.attachments === undefined ? null : <AttachmentGallery folderKey={props.folderKey} attachments={item.attachments} />}
          {item.delivery === undefined ? null : <p className="conversation-delivery">{item.delivery}</p>}
        </li>
      ))}
    </ol>
  )
}

function AgentDestination(props: { state: ConversationStateResult | null; onOpenChat(chatId: string): void }): JSX.Element {
  if (props.state === null) return <p className="conversation-agent ew-muted">Finding the receiving agent…</p>
  const chat = props.state.chat
  return (
    <p className="conversation-agent">
      <span>{agentLine(props.state)}</span>
      {chat === null ? null : (
        <button type="button" className="btn btn-ghost" onClick={() => props.onOpenChat(chat.id)}>Open chat</button>
      )}
    </p>
  )
}

interface DraftFieldProps {
  folderPath: string
  folderKey: string
  fieldKey: number
  draft: string
  images: FormImage[]
  onDraft(draft: string): void
  onImages(images: FormImage[]): void
  onUploading(uploading: boolean): void
}

function DraftField(props: DraftFieldProps): JSX.Element {
  const runner = useMemo(() => bindRunner(props.folderPath), [props.folderPath])
  return (
    <ImageAttachField
      key={props.fieldKey}
      runner={runner}
      folderKey={props.folderKey}
      images={props.images}
      onChange={props.onImages}
      onBusyChange={props.onUploading}
    >
      <label className="conversation-draft">
        <span>Message</span>
        <textarea
          value={props.draft}
          rows={3}
          maxLength={MAX_COMMENT_LENGTH + 1}
          placeholder="Message the agent in Markdown…"
          onChange={(event) => props.onDraft(event.target.value)}
        />
      </label>
    </ImageAttachField>
  )
}

function Composer(props: ConversationPanelProps & { onSent(result: SendConversationResult): void }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<FormImage[]>([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [fieldKey, setFieldKey] = useState(0)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!canSubmitComment(draft, busy || uploading)) return
    setBusy(true)
    setProblem(null)
    try {
      const attachments = images.map((image) => image.id)
      const result = await unwrapChat(
        window.dm.chats.sendConversationMessage({
          folder: props.folderPath,
          target: props.target,
          body: draft,
          ...(attachments.length === 0 ? {} : { attachments })
        })
      )
      setDraft('')
      setImages([])
      setFieldKey((key) => (key === 0 ? 1 : 0))
      setProblem(result.problem)
      props.onSent(result)
    } catch (failure: unknown) {
      setProblem(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="conversation-composer" onSubmit={(event) => void submit(event)}>
      <DraftField
        folderPath={props.folderPath} folderKey={props.folderKey}
        fieldKey={fieldKey} draft={draft} images={images}
        onDraft={setDraft} onImages={setImages} onUploading={setUploading}
      />
      {problem === null ? null : <p role="alert" className="conversation-error">{problem}</p>}
      <div className="conversation-actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmitComment(draft, busy || uploading)}>Send</button>
      </div>
    </form>
  )
}

/** Reusable durable board conversation: routed thread, destination and image-capable composer. */
export function ConversationPanel(props: ConversationPanelProps): JSX.Element {
  const [refresh, setRefresh] = useState(0)
  const loaded = useConversation(props, refresh)
  return (
    <section className="conversation-panel" aria-label="Conversation panel">
      <AgentDestination state={loaded.state} onOpenChat={props.onOpenChat} />
      <Thread loaded={loaded} folderKey={props.folderKey} />
      {props.canSend ? <Composer {...props} onSent={() => setRefresh((count) => count + 1)} /> : <p className="ew-muted">This conversation is read-only.</p>}
    </section>
  )
}
