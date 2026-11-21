import { useEffect, useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { StorageStatusView } from '../../../shared/domain/views'
import { StorageModeSwitch } from '../home/StorageModeSwitch'
import { callGithub } from '../api/github'
import { Button } from '../components/Button'

const CREATE_WORLD = 'create-forge-world'

interface Props {
  folder: TrackedFolderView
  folders: readonly TrackedFolderView[]
  status: StorageStatusView | null
  initialize(mode: 'repo' | 'db'): Promise<void>
  open(path: string): Promise<void>
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

function WorldSource({ folder, folders, open, controls }: SourceProps) {
  const { api, defaultName, remote, repository, search, name, setName, busy, act, selector, choice, minutes, setMinutes } = controls
  return <>
      <h3>Tracked repositories</h3>
      {folders.filter(f => f.forgeParent === folder.path).map(f => <p key={f.path}><Button onClick={() => open(f.path)}>{f.name}</Button></p>)}
      <div className="button-row">{repository}{search}<label>Project folder <input value={name} placeholder={defaultName} onChange={e => setName(e.target.value)} /></label>
        <Button disabled={busy || !remote} onClick={() => void act(() => api!.add(folder.path, remote, name || defaultName))}>Add repository</Button>
      </div>
      <h3>Convert a local project</h3>
      {selector(folders.filter(f => !f.forgeWorld && !f.forgeParent), 'Project')}
      <p>After the tickets reach GitHub, conversion replaces managed files in the code repository with a Forge World note.</p>
      <Button disabled={busy} onClick={() => void act(() => api!.pickConvert(folder.path))}>Choose a local repository to convert</Button>
      <Button disabled={busy || !choice} onClick={() => void act(() => api!.convert(folder.path, choice))}>Move tickets to Forge World</Button>
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

function ForgeDestination({ folder, open, controls }: Pick<SourceProps, 'folder' | 'open' | 'controls'>) {
  const { api, remote, repository, search, busy, act, choice } = controls
  if (choice === CREATE_WORLD) return <>
        {repository}
        <p>Create a private GitHub repository, push this project’s tickets, and replace its managed files with a Forge World note.</p>
        <Button disabled={busy || !remote.trim()} onClick={() => void act(async () => {
          const root = await api!.connect(folder.path, remote.trim(), true)
          controls.setChoice(root)
          await api!.convert(root, folder.path)
          await open(root)
        })}>Create and migrate</Button>
  </>
  return <>
      <Button disabled={busy || !choice} onClick={() => void act(() => api!.convert(choice, folder.path))}>Use Forge World storage</Button>
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
    {message && <p role="status">{message}</p>}
  </div></section>
}
