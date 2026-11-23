import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { ForgeProvisionRequest, ForgeProvisionResult, ForgeProvisionStatus, ForgeRecipe, ForgeSetupApi } from '../../../shared/desktop/forgeSetup'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { SignInPrompt } from '../github/SignInPrompt'
import { useGithubAccount } from '../github/useGithubAccount'
import './forgeSetup.css'

interface Props {
  api: Pick<ForgeSetupApi, 'recipebook' | 'provisioning' | 'provision' | 'resumeProvision'>
  world?: TrackedFolderView
  agents: readonly AgentView[]
  scheduler: Scheduler
  recovery: RefObject<ForgeProvisionAttempt | null>
  onClose(): void
  onProvisioned(result: ForgeProvisionStatus): void
}

export interface ForgeProvisionAttempt {
  id: string
  request: ForgeProvisionRequest
}

const phases: Record<ForgeProvisionStatus['phase'], string> = {
  checking: 'Creation settings', 'world-remote': 'Ticket repository publication',
  'world-checkout': 'Forge World checkout', 'code-remote': 'Code repository publication',
  'code-checkout': 'Local code checkout', member: 'Project membership',
  publish: 'World sync and onboarding', complete: 'Repository creation complete'
}

function verifiedReceipt(result: ForgeProvisionResult, operationId: string): ForgeProvisionResult {
  if (result !== null && result.state !== 'refused' && result.id !== operationId) {
    throw new Error('The creation receipt did not match this request.')
  }
  return result
}

function pendingIn(jobs: ForgeProvisionStatus[], world: string | undefined): ForgeProvisionStatus[] {
  return jobs.filter(job => {
    if (job.state === 'complete') return false
    const target = job.request.world
    return world === undefined ? target.kind === 'new' : target.kind === 'existing' && target.folder === world
  })
}

function useCodeRecipes(api: Props['api'], world: string | undefined) {
  const [recipes, setRecipes] = useState<ForgeRecipe[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void (async () => (await api.recipebook(world)) ?? (world === undefined ? null : await api.recipebook()))().then(book => {
      if (live) setRecipes(book?.value.recipes.filter(recipe => recipe.kind !== 'world') ?? [])
    }, failure => {
      if (live) setError(errorMessage(failure))
    })
    return () => { live = false }
  }, [api, world])
  return { recipes, error }
}

function useProvisionProgress({ api, busy, operation, scheduler, active, setJob }: {
  api: Props['api']; busy: boolean; operation: RefObject<ForgeProvisionAttempt | null>; scheduler: Scheduler
  active: RefObject<boolean>; setJob(job: ForgeProvisionStatus): void
}): void {
  useEffect(() => {
    if (!busy) return
    let live = true
    let pending = false
    const stop = scheduler.every(1200, () => {
      const id = operation.current?.id
      if (pending || id === undefined) return
      pending = true
      void api.provisioning().then(jobs => {
        const value = jobs.find(job => job.id === id)
        if (live && active.current && value?.state === 'running') setJob(value)
      }).catch(() => undefined).finally(() => { pending = false })
    })
    return () => { live = false; stop() }
  }, [api, busy, operation, scheduler, active, setJob])
}

function useProvisionOperation(onStart: () => void, onResult: (result: ForgeProvisionResult) => void, onError: (error: unknown) => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const perform = async (action: () => Promise<ForgeProvisionResult>): Promise<void> => {
    if (active.current) return
    active.current = true
    setBusy(true)
    onStart()
    try {
      onResult(await action())
    } catch (failure) {
      await onError(failure)
    } finally {
      active.current = false
      setBusy(false)
    }
  }
  return { busy, active, perform }
}

function useSavedIntents(api: Props['api']) {
  const [jobs, setJobs] = useState<ForgeProvisionStatus[]>([])
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)

  const reload = useCallback(async (): Promise<ForgeProvisionStatus[] | null> => {
    const request = ++sequence.current
    setChecking(true)
    try {
      const jobs = await api.provisioning()
      if (request !== sequence.current) return null
      setJobs(jobs)
      setError(null)
      return jobs
    } catch (failure) {
      if (request === sequence.current) setError(errorMessage(failure))
      return null
    } finally {
      if (request === sequence.current) setChecking(false)
    }
  }, [api])

  useEffect(() => {
    void reload()
    return () => { sequence.current += 1 }
  }, [reload])
  const remember = (job: ForgeProvisionStatus): void => {
    setJobs(previous => [job, ...previous.filter(entry => entry.id !== job.id)])
  }
  return { jobs, checking, error, reload, remember }
}

function useProvisionReceipt(api: Props['api'], onProvisioned: Props['onProvisioned'], recovery: Props['recovery']) {
  const saved = useSavedIntents(api)
  const [selected, setJob] = useState<ForgeProvisionStatus | null>(null)
  const [uncertain, setUncertain] = useState(recovery.current !== null)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef(recovery.current)

  function accept(result: ForgeProvisionResult): void {
    recovery.current = null
    if (result?.state === 'refused') {
      operation.current = null
      setError(result.message)
      return
    }
    setJob(result)
    setUncertain(false)
    if (result === null) operation.current = null
    else saved.remember(result)
    if (result?.state === 'complete') onProvisioned(result)
  }

  const inspect = async (id: string | undefined): Promise<void> => {
    const jobs = await saved.reload()
    if (jobs === null || id === undefined) return
    const record = jobs.find(job => job.id === id)
    if (record === undefined) setUncertain(true)
    else accept(record)
  }

  const { busy, active, perform } = useProvisionOperation(() => setError(null), accept, async failure => {
    recovery.current = operation.current
    setUncertain(true)
    setError(errorMessage(failure))
    await inspect(operation.current?.id)
  })
  const begin = (attempt: ForgeProvisionAttempt, work: () => Promise<ForgeProvisionResult>): Promise<void> => {
    if (active.current) return Promise.resolve()
    operation.current = attempt
    return perform(async () => verifiedReceipt(await work(), attempt.id))
  }
  const uncertainRequest = uncertain ? operation.current?.request : undefined
  return { saved, selected, setJob, uncertain, uncertainRequest, unknown: uncertain || saved.error !== null,
    error: error ?? saved.error, operation, inspect, busy, active, begin }
}

function useProvisioning({ api, world, onProvisioned, scheduler, recovery }: Props) {
  const model = useProvisionReceipt(api, onProvisioned, recovery)
  const { saved, selected, setJob, uncertain, operation, busy, active, begin, uncertainRequest } = model
  const choices = pendingIn(saved.jobs, world?.path)
  const operationId = operation.current?.id
  const singleSaved = operationId === undefined && !uncertain && choices.length === 1 ? choices[0] : null
  const job = selected ?? singleSaved
  useProvisionProgress({ api, busy, operation, scheduler, active, setJob })

  const create = (request: ForgeProvisionRequest): Promise<void> => {
    const id = crypto.randomUUID()
    setJob(null)
    return begin({ id, request }, () => api.provision(request, id))
  }
  const newDraft = (): void => {
    operation.current = null
    setJob(null)
  }
  return {
    choices, checking: saved.checking, unknown: model.unknown, job, setJob, busy, error: model.error,
    fromCurrentRequest: selected?.id !== undefined && selected.id === operationId,
    uncertainRequest,
    inspect: () => model.inspect(operationId ?? job?.id), create, newDraft,
    resume: (job: ForgeProvisionStatus) => begin(job, () => api.resumeProvision(job.id))
  }
}

type CodeRequest = NonNullable<ForgeProvisionRequest['code']>

interface CodeFieldsProps {
  code: CodeRequest
  update(code: CodeRequest): void
  agent: string
  onAgent(agent: string): void
  agents: readonly AgentView[]
  catalog: ReturnType<typeof useCodeRecipes>
}

function catalogMessage(catalog: CodeFieldsProps['catalog']): string {
  if (catalog.error !== null) return catalog.error
  return catalog.recipes === null ? 'Loading recipes…' : 'No code recipes are available.'
}

function CodeFields({ code, update, agents, agent, onAgent, catalog }: CodeFieldsProps): JSX.Element {
  const recipes = catalog.recipes ?? []
  const recipe = recipes.find(item => item.id === code.recipeId)
  return <>
    <Field label="Code repository name" value={code.name} onChange={name => update({ ...code, name })} maxLength={100} />
    <label className="field">
      <span className="field-label">Code repository visibility</span>
      <select className="input" value={code.visibility} onChange={e => update({ ...code, visibility: e.target.value === 'public' ? 'public' : 'private' })}>
        <option value="private">Private</option><option value="public">Public</option>
      </select>
    </label>
    <label className="field">
      <span className="field-label">Recipe</span>
      <select className="input" value={code.recipeId} onChange={e => update({ ...code, recipeId: e.target.value })} disabled={recipes.length === 0}>
        {recipes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        {recipes.length === 0 && <option value="">{catalogMessage(catalog)}</option>}
      </select>
    </label>
    {recipe?.kind === 'conversion' && <p className="muted">Conversion required. The repository will need a verified Electron build and launch.</p>}
    <label className="field">
      <span className="field-label">Setup agent</span>
      <select className="input" value={agent} onChange={e => onAgent(e.target.value)}>
        <option value="">Use the project’s preferred agent</option>
        {agents.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
      </select>
    </label>
    <p className="muted">Choose a code checkout location outside the Forge World when prompted.</p>
  </>
}

function ProvisionProgress({ job, checking, unknown, uncertainRequest }: Pick<ReturnType<typeof useProvisioning>, 'job' | 'checking' | 'unknown' | 'uncertainRequest'>): JSX.Element {
  const stage = job === null ? 'Waiting for creation progress…' : phases[job.phase]
  const label = checking ? 'Checking saved creation progress…' : stage
  return <section className="forge-provision-stage" aria-label="Creation progress">
    {uncertainRequest && <p>Creation request for {creationName(uncertainRequest)}</p>}
    <p role="status">{job?.state === 'needs-attention' && 'Needs attention · '}{label}</p>
    {job?.message && <p role="alert" className="forge-error">{job.message}</p>}
    {unknown && <p>Check progress before making another creation request.</p>}
  </section>
}

function creationName({ world, code }: ForgeProvisionRequest): string {
  if (world.kind === 'new') return code === undefined ? world.name : world.name + ' / ' + code.name
  return code?.name ?? world.folder
}

function ProvisionChoices({ choices, onChoose }: { choices: ForgeProvisionStatus[]; onChoose(job: ForgeProvisionStatus): void }): JSX.Element {
  return <section className="forge-provision-stage" aria-label="Saved creation requests">
    <ul className="forge-intents">
      {choices.map(job => <li key={job.id}>
        <Button onClick={() => onChoose(job)}>View creation for {creationName(job.request)}</Button>
        <span className="muted">{phases[job.phase]}</span>
      </li>)}
    </ul>
  </section>
}

function newRequest(world: TrackedFolderView | undefined, worldName: string): ForgeProvisionRequest['world'] {
  return world === undefined ? { kind: 'new', name: worldName.trim() } : { kind: 'existing', folder: world.path }
}

function selectedCodeFields(fields: CodeRequest, catalog: CodeFieldsProps['catalog']): CodeRequest {
  const available = catalog.recipes ?? []
  const selected = available.find(recipe => recipe.id === fields.recipeId) ?? available[0]
  return { ...fields, recipeId: selected?.id ?? '' }
}

function validCreation(request: ForgeProvisionRequest): boolean {
  if (request.world.kind === 'new' && request.world.name === '') return false
  const { code } = request
  return code === undefined || code.name !== '' && code.recipeId !== ''
}

function useCreationForm(world: TrackedFolderView | undefined, catalog: CodeFieldsProps['catalog']) {
  const [worldName, setWorldName] = useState('')
  const [makeCode, setMakeCode] = useState(world !== undefined)
  const [fields, setFields] = useState<CodeRequest>({ name: '', visibility: 'private', recipeId: '' })
  const [agent, setAgent] = useState('')
  const code = selectedCodeFields(fields, catalog)
  const request: ForgeProvisionRequest = { world: newRequest(world, worldName) }
  if (makeCode) {
    request.code = { ...code, name: code.name.trim() }
    if (agent) request.agent = agent
  }
  return { request, valid: validCreation(request), worldName, setWorldName, makeCode, setMakeCode, code, setFields, agent, setAgent }
}

function ProvisionForm({ world, agents, form, catalog }: {
  world?: TrackedFolderView; agents: Props['agents']; form: ReturnType<typeof useCreationForm>; catalog: CodeFieldsProps['catalog']
}): JSX.Element {
  return <div className="forge-form">
    {world ? <p>Forge World: {world.name}</p> : <>
      <Field label="World repository name" value={form.worldName} onChange={form.setWorldName} maxLength={100} hint="Forge Worlds are private." />
      <label><input type="checkbox" checked={form.makeCode} onChange={e => form.setMakeCode(e.target.checked)} /> Create a code repository</label>
    </>}
    {form.makeCode && <CodeFields code={form.code} update={form.setFields} agents={agents} agent={form.agent} onAgent={form.setAgent} catalog={catalog} />}
  </div>
}

function ProvisionAction({ model, request, progress, signedIn, valid }: {
  model: ReturnType<typeof useProvisioning>; request: ForgeProvisionRequest; progress: boolean; signedIn: boolean; valid: boolean
}): JSX.Element {
  const pending = model.job
  if (!progress) return <Button variant="primary" disabled={!signedIn || !valid} onClick={() => void model.create(request)}>Create</Button>
  if (pending?.state === 'needs-attention' && !model.unknown) return <Button variant="primary" busy={model.busy} disabled={!signedIn}
    onClick={() => void model.resume(pending)}>Resume creation</Button>
  return <Button disabled={model.checking || model.busy} onClick={() => void model.inspect()}>Check progress</Button>
}

function showProgress(model: ReturnType<typeof useProvisioning>, drafting: boolean): boolean {
  if (model.busy || model.checking || model.unknown || model.fromCurrentRequest) return true
  return !drafting && model.choices.length > 0
}

function ViewSavedIntents({ model, drafting, change }: {
  model: ReturnType<typeof useProvisioning>; drafting: boolean; change(drafting: boolean): void
}): JSX.Element | null {
  if (model.choices.length === 0 || model.busy || model.checking || model.unknown || model.job?.state === 'running') return null
  const newRequest = !drafting || model.fromCurrentRequest
  return <Button onClick={() => { model.newDraft(); change(newRequest) }}>{newRequest ? 'New creation' : 'Saved creations'}</Button>
}

function ProvisionStatus({ model }: { model: ReturnType<typeof useProvisioning> }): JSX.Element {
  if (!model.unknown && model.job === null && model.choices.length > 1) {
    return <ProvisionChoices choices={model.choices} onChoose={model.setJob} />
  }
  return <ProvisionProgress job={model.job} checking={model.checking} unknown={model.unknown} uncertainRequest={model.uncertainRequest} />
}

export function ProvisionDialog(props: Props): JSX.Element {
  const { account, loaded } = useGithubAccount()
  const catalog = useCodeRecipes(props.api, props.world?.path)
  const model = useProvisioning(props)
  const form = useCreationForm(props.world, catalog)
  const [drafting, setDrafting] = useState(false)
  const progress = showProgress(model, drafting)
  const close = (): void => { if (!model.busy) props.onClose() }
  return <Dialog title={props.world ? 'Create a code repository' : 'Create a Forge World'} onClose={close} actions={<>
    <Button disabled={model.busy} onClick={close}>{progress ? 'Close' : 'Cancel'}</Button>
    <ViewSavedIntents model={model} drafting={drafting} change={setDrafting} />
    <ProvisionAction model={model} request={form.request} progress={progress} signedIn={account !== null} valid={form.valid} />
  </>}>
    {model.error !== null && <p role="alert" className="forge-error">{model.error}</p>}
    {loaded && account === null && <SignInPrompt purpose="create repositories" />}
    {progress ? <ProvisionStatus model={model} /> : <ProvisionForm world={props.world} agents={props.agents} form={form} catalog={catalog} />}
  </Dialog>
}
