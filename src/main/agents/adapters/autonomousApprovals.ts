/**
 * How Autonomous asks to write a file: an ACP form elicitation, `elicitation/create`
 * (`{mode: 'form', sessionId, message, requestedSchema}` with one `value` field whose enum is
 * `["Approve", "Deny"]`), not `session/request_permission`, which it uses only for shell commands,
 * deletes and moves. It sends one only to a client that declared `clientCapabilities.elicitation.form`,
 * and refuses the write unasked otherwise. Source: docs/reports/autonomous-acp.md (DM-281, runs 4 to 6).
 *
 * The form becomes an approval request in the chat. Allow (once or for the chat) answers
 * `{action: 'accept', content: {value: 'Approve'}}`; Deny answers `{action: 'decline'}`, which a8s
 * reports as "Tool call denied by user: write". A turn stopped while the form is open answers
 * `decline` too, so nothing runs that the person did not allow. The form carries no `toolCallId`, so
 * a Deny marks the call a8s reported as pending right before it (the write's `tool_call` arrives
 * before the form) as refused. An elicitation of any other shape is declined, with a notice.
 */
import type { ApprovalCategory, ApprovalDecision, ApprovalRequestItem } from '../../../shared/agents/chat'
import { clip, objectOf } from './acp/acpJson'
import type { ExtensionContext } from './acp/acpSession'

const ACCEPT = { action: 'accept', content: { value: 'Approve' } } as const
const DECLINE = { action: 'decline' } as const

const MAX_SUMMARY_CHARS = 300

/** a8s's tools that change a file and ask through the form; any other tool it names is `other`. */
const FILE_TOOLS = new Set(['write', 'edit'])

/** True for the Approve/Deny form a8s's tool approval sends. */
function isApprovalForm(params: Record<string, unknown> | null): boolean {
  const value = objectOf(objectOf(objectOf(params?.requestedSchema)?.properties)?.value)
  return params?.mode === 'form' && Array.isArray(value?.enum) && value.enum.includes('Approve')
}

/** The approval request item for the form: the tool its message names (`Allow tool: write`), and the path it gives. */
function requestItem(message: string, chat: ExtensionContext): ApprovalRequestItem {
  const tool = /^Allow tool: (\S+)/m.exec(message)?.[1] ?? 'tool'
  const path = /^Path: (.+)$/m.exec(message)?.[1]
  const category: ApprovalCategory = FILE_TOOLS.has(tool) ? 'file_edit' : 'other'
  return {
    id: chat.newId(),
    at: chat.now(),
    kind: 'approval_request',
    requestId: chat.newId(),
    category,
    tool: clip(tool, 80),
    summary: message === '' ? 'Autonomous asks to use a tool' : clip(message, MAX_SUMMARY_CHARS),
    ...(path === undefined ? {} : { input: { path: clip(path, 2000) } })
  }
}

/** Answers an `elicitation/create`: the person's decision on a tool approval form, `decline` for anything else. */
export function answerElicitation(params: unknown, chat: ExtensionContext): unknown {
  const body = objectOf(params)
  if (!isApprovalForm(body)) {
    const message = 'Autonomous asked a question this chat cannot show yet, so it was declined. Answer in a message instead.'
    chat.emit({ type: 'item', item: { id: chat.newId(), at: chat.now(), kind: 'error', message, code: 'autonomous_question' } })
    return DECLINE
  }
  const request = requestItem(typeof body?.message === 'string' ? body.message : '', chat)
  return new Promise((resolve) => {
    let answered = false
    const answer = (result: unknown): void => {
      if (!answered) {
        answered = true
        resolve(result)
      }
    }
    chat.signal.addEventListener('abort', () => {
      answer(DECLINE)
    })
    const respond = (decision: ApprovalDecision): void => {
      if (!answered && decision === 'deny') {
        chat.denyPendingCall()
      }
      answer(decision === 'deny' ? DECLINE : ACCEPT)
    }
    try {
      chat.emit({ type: 'approval_request', request, respond })
    } catch {
      // Whatever went wrong on the way to the person, the agent is not left waiting, and nothing is allowed.
      answer(DECLINE)
    }
  })
}
