import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { MAX_TITLE } from '../home/newEpic'

interface FirstPromptDialogProps {
  onSubmit(prompt: string): Promise<boolean>
  onClose(): void
}

/** Nothing is created until Start succeeds. Failed creation leaves the original text here. */
export function FirstPromptDialog({ onSubmit, onClose }: FirstPromptDialogProps): JSX.Element {
  const formId = useId()
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const close = (): void => { if (!submitting.current) onClose() }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!prompt.trim() || prompt.length > 32_000 || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      if (await onSubmit(prompt)) onClose()
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Start a new chat"
      description="What would you like the agent to do? Your full prompt is sent once; the agent names the chat from its intent."
      onClose={close}
      actions={
        <>
          <Button disabled={busy} onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} busy={busy} disabled={!prompt.trim() || prompt.length > 32_000}>Start</Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={(event) => void submit(event)}>
        <Field label="First prompt" rows={6} maxLength={32_000} value={prompt} onChange={setPrompt} />
      </form>
    </Dialog>
  )
}

interface RenameChatDialogProps {
  chat: ChatRecord
  /** Resolves true once the chat has its new title (the dialog then closes), false if it could not be renamed. */
  onSubmit(title: string): Promise<boolean>
  onClose(): void
}

/** A chat's title, edited in place; an empty title cannot be saved. */
export function RenameChatDialog({ chat, onSubmit, onClose }: RenameChatDialogProps): JSX.Element {
  const formId = useId()
  const [title, setTitle] = useState(chat.title)
  const [busy, setBusy] = useState(false)
  const trimmed = title.trim()
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (trimmed === '' || busy) {
      return
    }
    setBusy(true)
    const renamed = trimmed === chat.title || (await onSubmit(trimmed))
    setBusy(false)
    if (renamed) {
      onClose()
    }
  }
  return (
    <Dialog
      title="Rename chat"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} busy={busy} disabled={trimmed === ''}>
            Rename chat
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={(event) => void submit(event)}>
        <Field label="Title" value={title} maxLength={MAX_TITLE} onChange={setTitle} />
      </form>
    </Dialog>
  )
}

interface DeleteChatDialogProps {
  chat: ChatRecord
  /** Resolves true once the chat is gone (the dialog then closes), false if it could not be deleted. */
  onConfirm(): Promise<boolean>
  onClose(): void
  boardConversation?: 'epic' | 'card'
}

/** Deleting asks first and says what goes, including the effect on a board-bound conversation. */
export function DeleteChatDialog({ chat, onConfirm, onClose, boardConversation }: DeleteChatDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    const deleted = await onConfirm()
    setBusy(false)
    if (deleted) {
      onClose()
    }
  }
  return (
    <Dialog
      title="Delete this chat?"
      description={`This removes the chat and its transcript from this computer. It cannot be undone. Your repository and anything the agent changed in it are not touched.${boardConversation === undefined ? '' : ` This unbinds it from the ${boardConversation}; the conversation history stays on the board.`}`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => void confirm()}>
            Delete chat
          </Button>
        </>
      }
    >
      <p className="dialog-path">{chat.title}</p>
    </Dialog>
  )
}
