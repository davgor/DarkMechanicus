import { useEffect, useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { StoredDeliveryPolicy } from '../../../shared/domain/deliveryPolicy'
import { baselineDeliveryPolicy, defaultPrompts, effectivePrompts } from '../../../shared/domain/standardsPrompts'
import { errorMessage, runCommand } from '../api/dm'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { ForgeOpen } from './ForgeOpen'
import { applyQuestion, standardsChat } from './standardsChat'

type Prompts = typeof defaultPrompts
type Launch = (project: TrackedFolderView, prompt: string) => Promise<void>

interface Props {
  folder: TrackedFolderView
  folders: readonly TrackedFolderView[]
  launch: Launch
  compact?: boolean
}

const controls = [
  ['planned', 'Planned standards', 'Ticket test cases, acceptance criteria, and deployable sprint outcomes.'],
  ['ticket', 'Ticket standards', 'Tests, review, and integration for epic tickets and standalone Kanban work.'],
  ['sprint', 'Sprint standards', 'Verification, merge, deployment, and the human checkpoint.'],
  ['epic', 'Epic standards', 'Evidence, final review, and closeout across delivered sprints.']
] as const

function PromptFields({ prompts, disabled, change }: { prompts: Prompts; disabled: boolean; change(value: Prompts): void }) {
  return <div className="standards-fields">{controls.map(([key, name, help]) =>
    <label className="standards-field" key={key}>
      <span className="standards-field-label"><strong>{name}</strong><span className="muted">{help}</span></span>
      <textarea aria-label={name} className="input" rows={5} maxLength={65536} disabled={disabled} value={prompts[key]}
        onChange={e => change({ ...prompts, [key]: e.target.value })} />
    </label>)}</div>
}

type Read = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; saved?: StoredDeliveryPolicy }

function usePolicy(path: string) {
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setRead({ kind: 'loading' })
    void runCommand(path, 'getProject', undefined).then(project => {
      if (current) setRead({ kind: 'ready', saved: project.deliveryStandards })
    }).catch(error => { if (current) setRead({ kind: 'error', message: errorMessage(error) }) })
    return () => { current = false }
  }, [path, attempt])
  return { read, reload: () => setAttempt(n => n + 1), saved: (value: StoredDeliveryPolicy) => setRead({ kind: 'ready', saved: value }) }
}

interface EditorProps {
  folder: TrackedFolderView
  saved?: StoredDeliveryPolicy
  launch: Launch
  compact?: boolean
  onSave(value: StoredDeliveryPolicy): void
  reload(): void
}

function useEditor({ folder, saved, onSave }: EditorProps) {
  const original = effectivePrompts(saved?.policy)
  const [prompts, setPrompts] = useState(original)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = controls.some(([key]) => prompts[key] !== original[key])
  const valid = controls.every(([key]) => prompts[key].trim().length > 0)
  async function perform(work: () => Promise<void>) {
    setError('')
    setBusy(true)
    try { await work() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  function save() {
    void perform(async () => {
      const policy = { ...(saved?.policy ?? baselineDeliveryPolicy), prompts, setupDecision: changed ? 'edited' as const : 'defaults' as const }
      onSave(await runCommand(folder.path, 'setDeliveryStandards', { expectedRevision: saved?.revision ?? 0, policy }))
    })
  }

  return { prompts, setPrompts, busy, error, changed, valid, perform, save }
}

function EditorActions({ model, saved, compact, prepare, confirm }: {
  model: ReturnType<typeof useEditor>
  saved?: StoredDeliveryPolicy
  compact?: boolean
  prepare(): void
  confirm(): void
}) {
  const { busy, valid, changed, save } = model
  return <div className="button-row standards-actions">
      <Button variant="primary" disabled={busy || !valid || Boolean(saved && !changed)} onClick={save}>
        {!saved && !changed ? 'Accept defaults' : 'Save standards'}</Button>
      <Button disabled={busy || changed} onClick={() => void prepare()}>Prepare with agent</Button>
      {!compact && <Button disabled={busy || changed || !saved} onClick={() => confirm()}>Standardize tickets</Button>}
    </div>
}

function Editor(props: EditorProps) {
  const { folder, saved, launch, compact, reload } = props
  const model = useEditor(props)
  const { prompts, setPrompts, busy, error, perform } = model
  const [confirm, setConfirm] = useState(false)
  const revision = saved?.revision
  const startChat = (task: 'prepare' | 'standardize') => void perform(() => launch(folder, standardsChat(task, saved)))
  if (compact && saved) return null
  return <section className={compact ? 'standards-setup' : 'standards-editor'} aria-label="Project delivery standards">
    <header className="standards-heading"><div>
      <h2>{compact ? 'Set up delivery standards' : 'Delivery Standards'}</h2>
      <p className="muted">{saved ? `Saved revision ${saved.revision}` : 'Accept the Dark Mechanicus defaults or prepare standards with an agent.'}</p>
    </div></header>
    {!compact && <PromptFields prompts={prompts} disabled={busy} change={setPrompts} />}
    <EditorActions model={model} saved={saved} compact={compact} prepare={() => startChat('prepare')} confirm={() => setConfirm(true)} />
    {error && <div role="alert">{error} <Button size="sm" onClick={reload}>Reload saved standards</Button></div>}
    {confirm && <Dialog title="Standardize tickets" description={applyQuestion} onClose={() => setConfirm(false)}
      actions={<><Button onClick={() => setConfirm(false)}>Later</Button>
        <Button variant="primary" onClick={() => { setConfirm(false); startChat('standardize') }}>Yes, apply revision {revision}</Button></>}>
      <p>{folder.name} · Revision {revision}</p>
    </Dialog>}
  </section>
}

function ProjectStandards(props: Omit<Props, 'folders'>) {
  const policy = usePolicy(props.folder.path)
  if (policy.read.kind === 'loading') return props.compact ? null : <p className="standards-message" role="status">Loading delivery standards…</p>
  if (policy.read.kind === 'error') return <div className="standards-message">Could not load delivery standards. {policy.read.message} <Button size="sm" onClick={policy.reload}>Retry</Button></div>
  return <Editor {...props} saved={policy.read.saved} key={policy.read.saved?.revision ?? 0} onSave={policy.saved} reload={policy.reload} />
}

function Member({ folder, launch }: Pick<Props, 'folder' | 'launch'>) {
  const [open, setOpen] = useState(false)
  return <details className="standards-member" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{folder.name}</summary>{open && <ProjectStandards folder={folder} launch={launch} />}
  </details>
}

export function DeliveryStandards({ folder, folders, launch, compact }: Props) {
  if (folder.forgeWorld) {
    if (compact) return null
    const members = folders.filter(f => f.forgeParent === folder.path)
    return <div className="standards-editor"><h2>Delivery Standards</h2>
      {members.length === 0 ? <p>No managed projects.</p> : <ForgeOpen root={folder.path}>
        {members.map(member => <Member key={member.path} folder={member} launch={launch} />)}
      </ForgeOpen>}</div>
  }
  if (!folder.initialized) return compact ? null : <p className="standards-message">Choose a ticket store on the Ticket source control tab to configure delivery standards.</p>
  return <ProjectStandards key={folder.path} folder={folder} launch={launch} compact={compact} />
}
