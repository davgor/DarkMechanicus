import { useEffect, useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { SourceCheckoutView } from '../../../shared/desktop/sourceCheckout'
import type { StorageStatusView } from '../../../shared/domain/views'
import { StorageModeSwitch } from '../home/StorageModeSwitch'
import { callGithub } from '../api/github'
import { useGithubAccount } from '../github/useGithubAccount'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { RecipebookDialog } from '../forge/RecipebookDialog'

const CREATE_WORLD = 'create-forge-world'

interface Props {
  folder: TrackedFolderView
  folders: readonly TrackedFolderView[]
  status: StorageStatusView | null
  initialize(mode: 'repo' | 'db'): Promise<void>
  open(path: string): Promise<void>
  onCreateCode?(): void
}

function useTicketSource({ folder }: Props) {
  const api = window.dm.forge
  const world = folder.forgeWorld
  const [remote, setRemote] = useState('')
  const [repos, setRepos] = useState<string[]>([])
  const [name, setName] = useState('')
  const [choice, setChoice] = useState('')
  const [minutes, setMinutes] = useState(world?.syncMinutes ?? 5)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let current = true
    if (world && api) void api.status(folder.path).then(s => {
      if (current) setMessage(s.error ?? (s.last ? 'Last synced ' + new Date(s.last).toLocaleString() : 'Awaiting first sync'))
    }).catch(e => { if (current) setMessage(String(e)) })
    return () => { current = false }
  }, [api, folder.path, world])
  async function act(work: () => Promise<unknown>) {
    setBusy(true)
    setMessage('')
    try { await work() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { window.dispatchEvent(new Event('focus')); setBusy(false) }
  }
  const defaultName = remote.trim().replace(/\/$/, '').split('/').pop()?.replace(/\.git$/i, '') ?? ''
  const repository = <label>GitHub repository <input list="forge-repositories" placeholder="owner/repository" value={remote} onChange={e => setRemote(e.target.value)} /></label>
  const search = <Button disabled={busy} onClick={() => void act(async () => {
    setRepos((await callGithub(window.github.listRepositories())).map(r => r.fullName))
  })}>Find GitHub repositories</Button>
  const selector = (items: readonly TrackedFolderView[], label: string, allowCreate = false) => <label>{label} <select disabled={busy} value={choice} onChange={e => setChoice(e.target.value)}>
    <option value="">Select a folder</option>{allowCreate && <option value={CREATE_WORLD}>Create a Forge World…</option>}{items.map(f => <option key={f.path} value={f.path}>{f.name}</option>)}
  </select></label>
  return { api, defaultName, remote, repository, search, name, setName, busy, act, selector, choice, setChoice, minutes, setMinutes, repos, message }
}

type Controls = ReturnType<typeof useTicketSource>
type SourceProps = Props & { controls: Controls }

function ForceMigration({ world, source, initialized, controls }: { world: string; source: string; initialized: boolean; controls: Controls }) {
  const [confirming, setConfirming] = useState(false)
  const { api, busy, act } = controls
  return <>
    <Button disabled={busy || !world || !source || !initialized} onClick={() => setConfirming(true)}>Force migrate…</Button>
    {confirming && <Dialog title="Force migrate and restart unfinished work?" onClose={() => setConfirming(false)}
      actions={<><Button onClick={() => setConfirming(false)}>Cancel</Button><Button onClick={() => {
        setConfirming(false)
        void act(() => api!.convert(world, source, { force: true }))
      }}>Force migrate and restart</Button></>}>
      <p>Every unfinished epic restarts from its first ticket, including previously accepted tickets. Unfinished Kanban cards return to the backlog and active workers lose their claims.</p>
      <p>Completed epics and cards stay completed. All execution history is retained, with a private backup of the original store. Work will not start automatically.</p>
    </Dialog>}
  </>
}

function WorldSetupActions({ folder, onCreateCode }: Pick<Props, 'folder' | 'onCreateCode'>): JSX.Element | null {
  const api = window.dm.forgeSetup
  const [recipesOpen, setRecipesOpen] = useState(false)
  if (api === undefined) return null
  return <div className="forge-world-actions">
    <Button onClick={() => setRecipesOpen(true)}>Recipe book</Button>
    {onCreateCode && <Button onClick={onCreateCode}>New code repository</Button>}
    {recipesOpen && <RecipebookDialog api={api} world={folder.path} onClose={() => setRecipesOpen(false)} />}
  </div>
}

function WorldSource({ folder, folders, open, controls, onCreateCode }: SourceProps) {
  const { api, defaultName, remote, repository, search, name, setName, busy, act, selector, choice, minutes, setMinutes } = controls
  return <>
      <h3>Tracked repositories</h3>
      <WorldSetupActions folder={folder} onCreateCode={onCreateCode} />
      {folders.filter(f => f.forgeParent === folder.path).map(f => <p key={f.path}><Button onClick={() => open(f.path)}>{f.name}</Button></p>)}
      <div className="button-row">{repository}{search}<label>Project folder <input value={name} placeholder={defaultName} onChange={e => setName(e.target.value)} /></label>
        <Button disabled={busy || !remote} onClick={() => void act(() => api!.add(folder.path, remote, name || defaultName))}>Add repository</Button>
      </div>
      <h3>Convert a local project</h3>
      {selector(folders.filter(f => !f.forgeWorld && !f.forgeParent), 'Project')}
      <p>After the tickets reach GitHub, conversion replaces managed files in the code repository with a Forge World note.</p>
      <Button disabled={busy} onClick={() => void act(() => api!.pickConvert(folder.path))}>Choose a local repository to convert</Button>
      <Button disabled={busy || !choice} onClick={() => void act(() => api!.convert(folder.path, choice))}>Move tickets to Forge World</Button>
      <ForceMigration world={folder.path} source={choice} initialized={folders.find(f => f.path === choice)?.initialized === true} controls={controls} />
      <h3>Ticket sync</h3>
      <label>Interval in minutes <input type="number" min="1" max="1440" value={minutes} onChange={e => setMinutes(Number(e.target.value))} /></label>
      <Button disabled={busy} onClick={() => void act(() => api!.interval(folder.path, minutes))}>Save interval</Button>
      <Button disabled={busy} onClick={() => void act(() => api!.sync(folder.path))}>Sync now</Button>
  </>
}

function MemberSource({ folder, open, controls }: SourceProps) {
  const { api, busy, act } = controls
  return <><p>Ticket storage is managed by this project’s Forge World.</p><Button onClick={() => open(folder.forgeParent!)}>Open Forge World</Button>
      {(['db', 'repo'] as const).map(mode => <Button key={mode} disabled={busy} onClick={() => void act(async () => {
        const source = await api!.restore(folder.path, mode)
        if (source) await open(source)
      })}>{mode === 'db' ? 'Move to SQLite only' : 'Move to self-contained repo'}</Button>)}</>
}

function CreateForgeWorld({ folder, open, controls }: Pick<SourceProps, 'folder' | 'open' | 'controls'>) {
  const { api, busy, act } = controls
  const { account } = useGithubAccount()
  const [edited, setEdited] = useState<string>()
  const remote = edited ?? (account ? `${account.login}/Forge-World-${account.login}` : '')
  return <>
        <label>GitHub repository <input placeholder="owner/repository" value={remote} onChange={e => setEdited(e.target.value)} /></label>
        <p>Create a private GitHub repository, push this project’s tickets, and replace its managed files with a Forge World note.</p>
        <Button disabled={busy || !remote.trim()} onClick={() => void act(async () => {
          const root = await api!.connect(folder.path, remote.trim(), true)
          controls.setChoice(root)
          await api!.convert(root, folder.path)
          await open(root)
        })}>Create and migrate</Button>
  </>
}

function ForgeDestination({ folder, open, controls }: Pick<SourceProps, 'folder' | 'open' | 'controls'>) {
  const { api, remote, repository, search, busy, act, choice } = controls
  if (choice === CREATE_WORLD) return <CreateForgeWorld folder={folder} open={open} controls={controls} />
  return <>
      <Button disabled={busy || !choice} onClick={() => void act(() => api!.convert(choice, folder.path))}>Use Forge World storage</Button>
      <ForceMigration world={choice} source={folder.path} initialized={folder.initialized} controls={controls} />
      <div className="button-row">{repository}{search}
        <Button disabled={busy || !remote} onClick={() => void act(async () => open(await api!.connect(folder.path, remote, false)))}>Open existing Forge World</Button>
        <Button disabled={busy || !remote} onClick={() => void act(async () => open(await api!.connect(folder.path, remote, true)))}>Publish private Forge World</Button>
      </div>
  </>
}

function ProjectSource({ folder, folders, open, status, initialize, controls }: SourceProps) {
  const { api, busy, act, selector } = controls
  return <>
      <p>Current store: {folder.initialized ? folder.storageMode === 'db' ? 'SQLite only' : 'Self-contained repo' : 'Unconfigured'}</p>
      {folder.initialized && status && <StorageModeSwitch status={status} />}
      {!folder.initialized && <div className="button-row">
        <Button disabled={busy} onClick={() => void act(() => initialize('db'))}>Start with SQLite only</Button>
        <Button disabled={busy} onClick={() => void act(() => initialize('repo'))}>Start with self-contained repo</Button>
      </div>}
      <h3>Forge World</h3>
      {selector(folders.filter(f => f.forgeWorld), 'Ticket repository', true)}
      <ForgeDestination folder={folder} open={open} controls={controls} />
      {!folder.initialized && <Button disabled={busy} onClick={() => void act(() => api!.create(folder.path))}>Use this repository as a Forge World</Button>}
  </>
}

function RecoverySource({ controls }: { controls: Controls }) {
  const { busy, act } = controls
  const [checkout, setCheckout] = useState<SourceCheckoutView | null>(null)
  const api = window.dm.sourceCheckout
  useEffect(() => {
    let current = true
    void api.get().then(value => { if (current) setCheckout(value) }).catch(() => {})
    return () => { current = false }
  }, [api])
  return <>
    <h3>Tooling recovery source</h3>
    {checkout?.status === 'available' && <p>{checkout.local?.displayPath}</p>}
    {checkout?.status === 'unavailable' && <p>{checkout.message}</p>}
    <Button disabled={busy} onClick={() => void act(async () => {
      const choice = await api.pick()
      if (choice.outcome === 'associated') setCheckout(choice.checkout)
      else if (choice.outcome !== 'cancelled') throw new Error(choice.message + ' ' + choice.recovery)
    })}>Choose Dark Mechanicus source checkout…</Button>
  </>
}

export function TicketSource(props: Props): JSX.Element {
  const controls = useTicketSource(props)
  const { repos, message } = controls
  const folder = props.folder
  const world = folder.forgeWorld
  const Source = world ? WorldSource : folder.forgeParent ? MemberSource : ProjectSource
  return <section className="home ticket-source"><div className="card">
    <h2>{world ? folder.name : 'Ticket source control'}</h2>
    <datalist id="forge-repositories">{repos.map(r => <option key={r} value={r} />)}</datalist>
    <Source {...props} controls={controls} />
    {!world && <RecoverySource controls={controls} />}
    {message && <p role="status">{message}</p>}
  </div></section>
}
