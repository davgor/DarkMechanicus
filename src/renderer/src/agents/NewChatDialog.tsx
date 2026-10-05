import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { canSavePlans } from '../../../shared/agents/chat'
import type { ChatRole } from '../../../shared/agents/chat'
import type { CreateChatRequest } from '../../../shared/agents/chatApi'
import type { AgentAuthStatus, AgentKind, AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { AgentChoice, ModelChoice, RoleChoice } from './NewChatFields'
import type { AgentStatuses } from './useAgents'
import { useAgentModelChoice } from './useAgentModelChoice'
import type { AgentModelChoice } from './useAgentModelChoice'

/** What the person chose: exactly what the new chat is created with, in this folder. */
export type NewChatChoice = Required<Pick<CreateChatRequest, 'agent' | 'model' | 'role' | 'allowSave'>>

interface NewChatDialogProps {
  folder: TrackedFolderView
  /** The connected agents and their sign-in states. */
  agents: readonly AgentView[]
  statuses: AgentStatuses
  /** Resolves true once the chat exists (the dialog then closes), false if it could not be created. */
  onCreate(choice: NewChatChoice): Promise<boolean>
  /** Closes the dialog and opens the add-agent pane, for an agent that is not connected. */
  onAddAgent(): void
  /** A sign-in prompt in the dialog asked an agent's state itself: the shell shows what it found, and the agent can be chosen once it is signed in. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  onClose(): void
}

interface Draft {
  role: ChatRole
  /** Only used for the roles that can save plans; on until turned off. */
  allowSave: boolean
}

const INITIAL_DRAFT: Draft = { role: 'orchestrator', allowSave: true }

interface Form {
  choice: AgentModelChoice
  draft: Draft
  canStart: boolean
  busy: boolean
  change(patch: Partial<Draft>): void
  submit(event: FormEvent): Promise<void>
}

function useNewChatForm(props: NewChatDialogProps): Form {
  const [draft, setDraft] = useState(INITIAL_DRAFT)
  const [busy, setBusy] = useState(false)
  const choice = useAgentModelChoice(props.agents, props.statuses)
  const canStart = choice.settled && !busy
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (choice.agent === null || !canStart) {
      return
    }
    setBusy(true)
    const created = await props.onCreate({
      agent: choice.agent,
      model: choice.model,
      role: draft.role,
      allowSave: canSavePlans(draft.role) ? draft.allowSave : false
    })
    setBusy(false)
    if (created) props.onClose()
  }
  return { choice, draft, canStart, busy, change: (patch) => setDraft((previous) => ({ ...previous, ...patch })), submit }
}

function NewChatForm({ form, formId, props }: { form: Form; formId: string; props: NewChatDialogProps }): JSX.Element {
  const { draft, choice } = form
  return (
    <form id={formId} className="form" onSubmit={(event) => void form.submit(event)}>
      <AgentChoice
        agents={props.agents}
        statuses={props.statuses}
        value={choice.agent}
        onChange={choice.chooseAgent}
        onAddAgent={props.onAddAgent}
        onAgentStatus={props.onAgentStatus}
      />
      {choice.agent === null ? null : (
        <ModelChoice agent={choice.agent} state={choice.models} value={choice.model} onChange={choice.chooseModel} />
      )}
      <RoleChoice
        role={draft.role}
        allowSave={draft.allowSave}
        onRole={(role) => form.change({ role })}
        onAllowSave={(allowSave) => form.change({ allowSave })}
      />
    </form>
  )
}

/**
 * Starts a chat in a folder in three steps down one form: the agent (only connected, signed-in
 * ones can be chosen; a signed-out one has Sign in in the list and joins the choice once it is
 * signed in, without leaving the dialog; the others say where to fix that), then that agent's models, then the Dark Mechanicus role
 * and, for planner and orchestrator, Allow save (on by default). The chat opens once it is created.
 */
export function NewChatDialog(props: NewChatDialogProps): JSX.Element {
  const formId = useId()
  const form = useNewChatForm(props)
  return (
    <Dialog
      title={`New chat in ${props.folder.name}`}
      description="Choose an agent, then a model and a role. The chat opens as soon as it is created."
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} busy={form.busy} disabled={!form.canStart}>
            Start chat
          </Button>
        </>
      }
    >
      <NewChatForm form={form} formId={formId} props={props} />
    </Dialog>
  )
}
