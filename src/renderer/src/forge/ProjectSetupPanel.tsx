import { useState } from 'react'
import { stringify } from 'yaml'
import type { ForgeSetupApi, ForgeSetupConversationStatus, ForgeSetupDetectionReason, ForgeSetupFile,
  ForgeSetupProjectView, ForgeSetupWorkflow, ForgeSetupWorkflowEdit } from '../../../shared/desktop/forgeSetup'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { useForgeProjectSetup } from './useForgeProjectSetup'
import { EditWorkflowSteps, WorkflowSteps } from './WorkflowSteps'

interface Props {
  api: ForgeSetupApi
  member: string
  checkout: string | null
  scheduler: Scheduler
  onOpenChat(chatId: string): Promise<void>
}

const detectionReasons: Record<ForgeSetupDetectionReason, string> = {
  'no-node-manifest': 'No supported Node manifest was found.',
  'invalid-descriptor': 'The repository’s setup descriptors could not be read.',
  'descriptor-limits': 'The repository’s setup descriptors exceed the import limits.',
  'conflicting-requirements': 'The repository’s setup descriptors disagree.',
  'source-unavailable': 'The repository’s setup evidence is currently unavailable.'
}

const viewStates: Record<ForgeSetupProjectView['state'], string> = {
  missing: 'No portable setup workflow yet.',
  'needs-discovery': 'The workflow needs setup information.',
  configured: 'Workflow configured. Verify setup on this computer.',
  stale: 'Repository requirements changed. Review the workflow before running setup.'
}

const onboardingStates: Record<ForgeSetupConversationStatus['state'], string> = {
  preparing: 'Onboarding agent is preparing the workflow.',
  opened: 'The onboarding conversation includes workflow preparation and Delivery Standards.',
  'needs-attention': 'Onboarding needs attention.',
  uncertain: 'Onboarding delivery is unconfirmed. Open the conversation to check.'
}

const runStates: Record<NonNullable<ForgeSetupConversationStatus['run']>['state'], string> = {
  pending: 'Setup is being sent to the onboarding agent.',
  submitted: 'Setup sent to the agent. Check the conversation for local verification.',
  uncertain: 'Setup delivery is unconfirmed. Check the conversation before sending again.',
  failed: 'Setup could not be sent to the onboarding agent.'
}

function WorkflowDetails({ file }: { file: ForgeSetupFile<ForgeSetupWorkflow> }): JSX.Element {
  const [yamlOpen, toggleYaml] = useState(false)
  const { detection, notes, workflow, revision } = file.value
  return <>
    {detection.status !== 'detected' && <p>{detectionReasons[detection.reason]}</p>}
    <details>
      <summary>Requirements and workflow · Revision {revision}</summary>
      {detection.source !== null && <p className="forge-provenance">Source revision <code>{detection.source.commit}</code></p>}
      {detection.facts.length > 0 && <ul>
        {detection.facts.map(fact => <li key={JSON.stringify(fact)}>
          <strong>{fact.kind}</strong> {fact.value} <span className="muted">· {fact.source}</span>
        </li>)}
      </ul>}
      {notes && <p className="forge-notes">{notes}</p>}
      <WorkflowSteps steps={workflow.steps} />
      <details onToggle={event => toggleYaml(event.currentTarget.open)}>
        <summary>Workflow YAML</summary>
        {yamlOpen && <pre className="forge-data"><code>{stringify(file.value)}</code></pre>}
      </details>
    </details>
  </>
}

function ConversationNotice({ status }: { status: ForgeSetupConversationStatus }): JSX.Element {
  return <div>
    <p role="status">{status.message ?? onboardingStates[status.state]}</p>
    {status.run && <p role="status">{runStates[status.run.state]}</p>}
  </div>
}

function initialDraft(file: ForgeSetupFile<ForgeSetupWorkflow>): ForgeSetupWorkflowEdit {
  const { state, steps } = file.value.workflow
  return { expectedSha256: file.sha256, workflow: { state, steps }, notes: file.value.notes ?? '' }
}

interface WorkflowEditorProps {
  draft: ForgeSetupWorkflowEdit
  currentSha: string | undefined
  busy: boolean
  error: string | null
  update(draft: ForgeSetupWorkflowEdit): void
  onSave(): void
  onClose(): void
}

function WorkflowEditor({ draft, currentSha, busy, error, update, onSave, onClose }: WorkflowEditorProps): JSX.Element {
  const stale = draft.expectedSha256 !== currentSha
  return <Dialog title="Edit setup workflow" onClose={onClose} actions={<>
    <Button onClick={onClose} disabled={busy}>Cancel edits</Button>
    <Button variant="primary" onClick={onSave} busy={busy} disabled={stale}>Save workflow</Button>
  </>}>
    {error !== null && <p role="alert" className="forge-error">{error}</p>}
    {stale && <p role="status">A newer workflow is saved. Your draft remains here for review.</p>}
    <fieldset className="forge-edit-fields" disabled={busy}>
      <legend>Workflow content</legend>
      <Field label="Setup notes" rows={4} value={draft.notes ?? ''} onChange={notes => update({ ...draft, notes })} />
      <label>
        <input type="checkbox" checked={draft.workflow.state === 'configured'}
          onChange={e => update({ ...draft, workflow: { ...draft.workflow, state: e.target.checked ? 'configured' : 'needs-discovery' } })} />
        {' '}Setup steps are configured
      </label>
      <EditWorkflowSteps steps={draft.workflow.steps} disabled={busy}
        onChange={steps => update({ ...draft, workflow: { ...draft.workflow, steps } })} />
    </fieldset>
  </Dialog>
}

function SetupConfirmation({ revision, checkout, busy, onClose, onRun }: {
  revision: number; checkout: string; busy: boolean; onClose(): void; onRun(): void
}): JSX.Element {
  return <Dialog title="Set up environment" onClose={onClose} actions={<>
    <Button onClick={onClose} disabled={busy}>Cancel</Button>
    <Button variant="primary" onClick={onRun} busy={busy}>Run setup</Button>
  </>}>
    <p>The onboarding agent will follow workflow revision {revision} in this code checkout.</p>
    <p className="forge-provenance"><code>{checkout}</code></p>
  </Dialog>
}

function useSetupActions({ api, member, checkout, scheduler, onOpenChat }: Props) {
  const model = useForgeProjectSetup(api, member, scheduler)
  const [draft, edit] = useState<ForgeSetupWorkflowEdit | null>(null)
  const [confirmation, confirm] = useState<{ file: ForgeSetupFile<ForgeSetupWorkflow>; checkout: string } | null>(null)
  const file = model.view?.value
  const onboarding = model.view?.onboarding
  const recordConversation = (status: ForgeSetupConversationStatus): void => {
    model.setView(previous => previous === null ? previous : { ...previous, onboarding: status })
  }
  const open = async (chatId: string): Promise<void> => { await model.act(() => onOpenChat(chatId), () => undefined) }
  const openChat = async (): Promise<void> => {
    const existing = onboarding?.chatId
    if (existing) await open(existing)
    else {
      const result = await model.act(() => api.prepare(member), recordConversation)
      if (result?.chatId) await open(result.chatId)
    }
  }
  const save = async (): Promise<void> => {
    if (draft !== null && await model.act(() => api.saveWorkflow(member, draft), model.setView)) edit(null)
  }
  const run = async (): Promise<void> => {
    if (confirmation === null || confirmation.checkout !== checkout) return
    const result = await model.act(() => api.run(member, confirmation.file.sha256), recordConversation)
    confirm(null)
    if (result?.state === 'opened' && result.chatId) await open(result.chatId)
  }
  return { ...model, file, onboarding, draft, edit, confirmation, confirm, openChat, save, run,
    refresh: () => model.act(() => api.refresh(member), model.setView) }
}

function runAlreadyRequested(run: ForgeSetupConversationStatus['run'], sha256: string): boolean {
  return run?.state === 'pending' || run?.state === 'uncertain' || run?.state === 'submitted' && run.workflowSha256 === sha256
}

function OnboardingButton({ model }: { model: ReturnType<typeof useSetupActions> }): JSX.Element | null {
  const state = model.onboarding?.state
  if (model.onboarding?.chatId) return <Button size="sm" disabled={model.busy} onClick={() => void model.openChat()}>Open onboarding</Button>
  if (model.view === null || state === 'preparing' || state === 'uncertain') return null
  return <Button size="sm" disabled={model.busy} onClick={() => void model.openChat()}>Prepare with agent</Button>
}

function setupTarget(model: ReturnType<typeof useSetupActions>, checkout: string | null) {
  if (model.view?.state !== 'configured' || !model.file || checkout === null || runAlreadyRequested(model.onboarding?.run, model.file.sha256)) return null
  return { file: model.file, checkout }
}

function SetupButtons({ model, checkout }: { model: ReturnType<typeof useSetupActions>; checkout: string | null }): JSX.Element {
  const { file, busy } = model
  const target = setupTarget(model, checkout)
  return <div className="button-row">
    <OnboardingButton model={model} />
    {file && <Button size="sm" disabled={busy} onClick={() => model.edit(initialDraft(file))}>Edit workflow</Button>}
    <Button size="sm" disabled={busy} onClick={() => void model.refresh()}>Refresh requirements</Button>
    <Button size="sm" variant="primary" disabled={busy || target === null} onClick={() => model.confirm(target)}>Set up environment</Button>
  </div>
}

function SetupInformation({ model, checkout }: { model: ReturnType<typeof useSetupActions>; checkout: string | null }): JSX.Element {
  const { view, file, onboarding, readError } = model
  return <>
    {view ? <p>{viewStates[view.state]}</p> : readError === null && <p role="status">Reading the local workflow…</p>}
    {checkout === null && <p className="muted">A verified local code checkout is needed to run setup.</p>}
    {readError !== null && <p role="status">{readError} <Button size="sm" onClick={model.reload}>Reload workflow</Button></p>}
    {file && <WorkflowDetails file={file} />}
    {onboarding && <ConversationNotice status={onboarding} />}
  </>
}

export function ProjectSetupPanel(props: Props): JSX.Element {
  const model = useSetupActions(props)
  const { checkout } = props
  const { file, draft, confirmation, busy, error } = model
  const closeEditor = (): void => { if (!busy) model.edit(null) }
  const closeConfirmation = (): void => { if (!busy) model.confirm(null) }
  return <section className="forge-setup-card" aria-label="Environment setup">
    <h2>Environment setup</h2>
    <SetupInformation model={model} checkout={checkout} />
    {error !== null && draft === null && <p role="alert" className="forge-error">{error}</p>}
    <SetupButtons model={model} checkout={checkout} />
    {draft && <WorkflowEditor draft={draft} currentSha={file?.sha256} busy={busy} error={error}
      update={model.edit} onSave={() => void model.save()} onClose={closeEditor} />}
    {confirmation && checkout === confirmation.checkout && <SetupConfirmation revision={confirmation.file.value.revision}
      checkout={checkout} busy={busy} onClose={closeConfirmation} onRun={() => void model.run()} />}
  </section>
}
