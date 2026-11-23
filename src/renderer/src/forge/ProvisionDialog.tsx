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
  onClose(): void
  onProvisioned(result: ForgeProvisionStatus): void
}

const phases: Record<ForgeProvisionStatus['phase'], string> = {
  checking: 'Creation settings', 'world-remote': 'Ticket repository publication',
  'world-checkout': 'Forge World checkout', 'code-remote': 'Code repository publication',
  'code-checkout': 'Local code checkout', member: 'Project membership',
  publish: 'World sync and onboarding', complete: 'Repository creation complete'
}

type ProvisionQuery = { id: string } | { request: ForgeProvisionRequest }

function sameCode(first: ForgeProvisionRequest['code'], second: ForgeProvisionRequest['code']): boolean {
  if (!first || !second) return first === second
  return first.name.toLowerCase() === second.name.toLowerCase() && first.visibility === second.visibility && first.recipeId === second.recipeId
}

function sameRequest(first: ForgeProvisionRequest, second: ForgeProvisionRequest): boolean {
  const a = first.world
  const b = second.world
  const sameWorld = a.kind === 'new'
    ? b.kind === 'new' && a.name.toLowerCase() === b.name.toLowerCase()
    : b.kind === 'existing' && a.folder === b.folder
  return sameWorld && first.agent === second.agent && sameCode(first.code, second.code)
}

function findJob(jobs: ForgeProvisionStatus[], query: ProvisionQuery): ForgeProvisionStatus | undefined {
  return 'id' in query ? jobs.find(job => job.id === query.id) : jobs.find(job => sameRequest(job.request, query.request))
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

function useProvisionProgress({ api, busy, query, scheduler, active, setJob }: {
  api: Props['api']; busy: boolean; query: RefObject<ProvisionQuery | null>; scheduler: Scheduler
  active: RefObject<boolean>; setJob(job: ForgeProvisionStatus): void
}): void {
  useEffect(() => {
    if (!busy) return
    let live = true
    let pending = false
    const stop = scheduler.every(1200, () => {
      const current = query.current
      if (pending || current === null) return
      pending = true
      void api.provisioning().then(jobs => {
        const value = findJob(jobs, current)
        if (live && active.current && value?.state === 'running') setJob(value)
      }).catch(() => undefined).finally(() => { pending = false })
    })
    return () => { live = false; stop() }
  }, [api, busy, query, scheduler, active, setJob])
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

function useSavedIntents(api: Props['api'], world: string | undefined) {
  const [choices, setChoices] = useState<ForgeProvisionStatus[]>([])
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)

  const reload = useCallback(async (): Promise<ForgeProvisionStatus[] | null> => {
    const request = ++sequence.current
    setChecking(true)
    try {
      const jobs = await api.provisioning()
      if (request !== sequence.current) return null
      setChoices(pendingIn(jobs, world))
      setError(null)
      return jobs
    } catch (failure) {
      if (request === sequence.current) setError(errorMessage(failure))
      return null
    } finally {
      if (request === sequence.current) setChecking(false)
    }
  }, [api, world])

  useEffect(() => {
    void reload()
    return () => { sequence.current += 1 }
  }, [reload])
  return { choices, checking, error, reload }
}

function useProvisioning({ api, world, onProvisioned, scheduler }: Props) {
  const { choices, checking, error: lookupError, reload } = useSavedIntents(api, world?.path)
  const [selected, setJob] = useState<ForgeProvisionStatus | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const query = useRef<ProvisionQuery | null>(null)
  const singleSaved = !uncertain && choices.length === 1 ? choices[0] : null
  const job = selected ?? singleSaved

  function accept(result: ForgeProvisionResult): void {
    if (result?.state === 'refused') {
      query.current = null
      setError(result.message)
      return
    }
    setJob(result)
    setUncertain(false)
    if (result?.state === 'complete') onProvisioned(result)
  }

  const inspect = async (): Promise<void> => {
    const current = query.current ?? (job === null ? null : { id: job.id })
    const jobs = await reload()
    if (jobs === null || current === null) return
    const record = findJob(jobs, current)
    if (record === undefined) setUncertain(true)
    else accept(record)
  }

  const { busy, active, perform } = useProvisionOperation(() => setError(null), accept, async failure => {
    setUncertain(true)
    setError(errorMessage(failure))
    await inspect()
  })
  useProvisionProgress({ api, busy, query, scheduler, active, setJob })

  const create = (request: ForgeProvisionRequest): Promise<void> => {
    query.current = { request }
    return perform(() => api.provision(request))
  }
  const resume = (id: string): Promise<void> => {
    query.current = { id }
    return perform(() => api.resumeProvision(id))
  }
  return { choices, checking, unknown: uncertain || lookupError !== null, job, setJob, busy,
    error: error ?? lookupError, inspect, create, resume }
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
        {recipes.length === 0 && <option value="">{catalog.error ?? 'Loading recipes…'}</option>}
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

function ProvisionProgress({ job, checking, unknown }: Pick<ReturnType<typeof useProvisioning>, 'job' | 'checking' | 'unknown'>): JSX.Element {
  const stage = job === null ? 'Waiting for creation progress…' : phases[job.phase]
  const label = checking ? 'Checking saved creation progress…' : stage
  return <section className="forge-provision-stage" aria-label="Creation progress">
    <p role="status">{job?.state === 'needs-attention' && 'Needs attention · '}{label}</p>
    {job?.message && <p role="alert" className="forge-error">{job.message}</p>}
    {unknown && <p>Check progress before making another creation request.</p>}
  </section>
}

function creationName({ request }: ForgeProvisionStatus): string {
  const { world, code } = request
  if (world.kind === 'new') return code === undefined ? world.name : world.name + ' / ' + code.name
  return code?.name ?? world.folder
}

function ProvisionChoices({ choices, onChoose }: { choices: ForgeProvisionStatus[]; onChoose(job: ForgeProvisionStatus): void }): JSX.Element {
  return <section className="forge-provision-stage" aria-label="Saved creation requests">
    <ul className="forge-intents">
      {choices.map(job => <li key={job.id}>
        <Button onClick={() => onChoose(job)}>View creation for {creationName(job)}</Button>
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
    onClick={() => void model.resume(pending.id)}>Resume creation</Button>
  return <Button disabled={model.checking || model.busy} onClick={() => void model.inspect()}>Check progress</Button>
}

function hasPendingCreation(model: ReturnType<typeof useProvisioning>): boolean {
  return model.busy || model.checking || model.unknown || model.job !== null || model.choices.length > 0
}

function ProvisionStatus({ model }: { model: ReturnType<typeof useProvisioning> }): JSX.Element {
  if (!model.unknown && model.job === null && model.choices.length > 1) {
    return <ProvisionChoices choices={model.choices} onChoose={model.setJob} />
  }
  return <ProvisionProgress job={model.job} checking={model.checking} unknown={model.unknown} />
}

export function ProvisionDialog(props: Props): JSX.Element {
  const { account, loaded } = useGithubAccount()
  const catalog = useCodeRecipes(props.api, props.world?.path)
  const model = useProvisioning(props)
  const form = useCreationForm(props.world, catalog)
  const progress = hasPendingCreation(model)
  const close = (): void => { if (!model.busy) props.onClose() }
  return <Dialog title={props.world ? 'Create a code repository' : 'Create a Forge World'} onClose={close} actions={<>
    <Button disabled={model.busy} onClick={close}>{progress ? 'Close' : 'Cancel'}</Button>
    <ProvisionAction model={model} request={form.request} progress={progress} signedIn={account !== null} valid={form.valid} />
  </>}>
    {model.error !== null && <p role="alert" className="forge-error">{model.error}</p>}
    {loaded && account === null && <SignInPrompt purpose="create repositories" />}
    {progress ? <ProvisionStatus model={model} /> : <ProvisionForm world={props.world} agents={props.agents} form={form} catalog={catalog} />}
  </Dialog>
}
