import { useEffect, useRef, useState, type RefObject } from 'react'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { ForgeProvisionRequest, ForgeProvisionStatus, ForgeRecipe, ForgeSetupApi } from '../../../shared/desktop/forgeSetup'
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

const phaseText: Record<ForgeProvisionStatus['phase'], string> = {
  checking: 'Checking creation settings', 'world-remote': 'Publishing the ticket repository',
  'world-checkout': 'Opening the Forge World checkout', 'code-remote': 'Publishing the code repository',
  'code-checkout': 'Preparing the local code checkout', member: 'Linking the code repository',
  publish: 'Syncing the world and preparing onboarding', complete: 'Repository creation complete'
}

function matchesWorld(request: ForgeProvisionRequest, world: string | undefined): boolean {
  return world === undefined ? request.world.kind === 'new' : request.world.kind === 'existing' && request.world.folder === world
}

function currentJob(jobs: ForgeProvisionStatus[], world: string | undefined, current: string | undefined): ForgeProvisionStatus | undefined {
  return current === undefined
    ? jobs.find(job => job.state !== 'complete' && matchesWorld(job.request, world))
    : jobs.find(job => job.id === current)
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

function useProvisionProgress({ api, busy, id, path, scheduler, active, setJob }: {
  api: Props['api']; busy: boolean; id?: string; path?: string; scheduler: Scheduler
  active: RefObject<boolean>; setJob(job: ForgeProvisionStatus): void
}): void {
  useEffect(() => {
    if (!busy) return
    let live = true
    let pending = false
    const stop = scheduler.every(1200, () => {
      if (pending) return
      pending = true
      void api.provisioning().then(jobs => {
        const value = currentJob(jobs, path, id)
        if (live && active.current && value?.state === 'running') setJob(value)
      }).catch(() => undefined).finally(() => { pending = false })
    })
    return () => { live = false; stop() }
  }, [api, busy, id, path, scheduler, active, setJob])
}

function useProvisionOperation(onResult: (result: ForgeProvisionStatus | null) => void, onError: (error: unknown) => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const active = useRef(false)
  const perform = async (action: () => Promise<ForgeProvisionStatus | null>): Promise<void> => {
    if (active.current) return
    active.current = true
    setBusy(true)
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

function useProvisioning({ api, world, onProvisioned, scheduler }: Props) {
  const path = world?.path
  const [checking, setChecking] = useState(true)
  const [unknown, setUnknown] = useState(false)
  const [job, setJob] = useState<ForgeProvisionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const unresolved = useRef(false)

  function accept(value: ForgeProvisionStatus | null): void {
    setJob(value)
    unresolved.current = false
    setUnknown(false)
    if (value?.state === 'complete') onProvisioned(value)
  }

  const inspect = async (): Promise<void> => {
    setChecking(true)
    try {
      const result = currentJob(await api.provisioning(), path, job?.id)
      if (result !== undefined) accept(result)
      else if (!unresolved.current) { setUnknown(false); setError(null) }
    } catch (failure) {
      setUnknown(true)
      setError(errorMessage(failure))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    let live = true
    void api.provisioning().then(jobs => {
      if (live) { setJob(currentJob(jobs, path, undefined) ?? null); setChecking(false) }
    }, failure => {
      if (live) { setError(errorMessage(failure)); setUnknown(true); setChecking(false) }
    })
    return () => { live = false }
  }, [api, path])

  const { busy, active, perform } = useProvisionOperation(accept, async failure => {
    unresolved.current = true
    setUnknown(true)
    setError(errorMessage(failure))
    await inspect()
  })
  useProvisionProgress({ api, busy, id: job?.id, path, scheduler, active, setJob })
  return { checking, unknown, job, busy, error, inspect,
    create: (input: ForgeProvisionRequest) => perform(() => api.provision(input)),
    resume: (id: string) => perform(() => api.resumeProvision(id)) }
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
  const step = job === null ? 'Waiting for creation progress…' : phaseText[job.phase]
  return <section className="forge-provision-stage" aria-label="Creation progress">
    <p role="status">{checking ? 'Checking saved creation progress…' : step}</p>
    {job?.message && <p role="alert" className="forge-error">{job.message}</p>}
    {unknown && <p>Check progress before making another creation request.</p>}
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
  return model.busy || model.checking || model.unknown || model.job !== null
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
    {progress ? <ProvisionProgress job={model.job} checking={model.checking} unknown={model.unknown} />
      : <ProvisionForm world={props.world} agents={props.agents} form={form} catalog={catalog} />}
  </Dialog>
}
