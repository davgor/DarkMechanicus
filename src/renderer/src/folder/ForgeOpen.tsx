import { useEffect, useState, type ReactNode } from 'react'
import type { ForgeApi, ForgeMemberStatus } from '../../../shared/desktop/forgeWorld'
import { errorMessage } from '../api/dm'
import { browserScheduler, type Scheduler } from '../app/scheduler'
import { useViewMemory } from '../epic/viewMemory'
import { Button } from '../components/Button'
import './forgeOpen.css'

export const FORGE_STATUS_MS = 2000

interface Props {
  root: string
  member: string
  identity?: string
  children: ReactNode
  scheduler?: Scheduler
  fullHeight?: boolean
}

function useMemberStatus(api: ForgeApi | undefined, { root, member, identity, scheduler = browserScheduler }: Props, attempt: number) {
  const memory = useViewMemory()
  const [status, setStatus] = useState<ForgeMemberStatus | null>(() => identity === undefined ? null : memory.forgeStatus(identity) ?? null)
  const [statusError, setStatusError] = useState<string | null>(null)
  useEffect(() => {
    if (api === undefined) return
    let current = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const next = await api.memberStatus(root, member)
        if (current) {
          if (identity !== undefined) memory.saveForgeStatus(identity, next)
          setStatus(next)
          setStatusError(null)
        }
      } catch (error) {
        if (current) setStatusError(errorMessage(error))
      } finally {
        pending = false
      }
    }
    void refresh()
    const stop = scheduler.every(FORGE_STATUS_MS, () => void refresh())
    return () => { current = false; stop() }
  }, [api, root, member, identity, scheduler, attempt, memory])
  return { status, statusError, setStatusError }
}

interface NoticeProps {
  ready: boolean
  syncing: boolean
  error: string | null
  retry?: { label: string; onClick(): void }
}

function ForgeNotice({ ready, syncing, error, retry }: NoticeProps): JSX.Element | null {
  const message = syncing
    ? ready ? 'Syncing Forge World tickets in the background…' : 'Preparing Forge World tickets…'
    : error ?? (ready ? null : 'Preparing local Forge World tickets…')
  if (message === null) return null
  return <div className="forge-status" role="status">
    <span>{message}</span>
    {!syncing && error !== null && retry !== undefined && <Button size="sm" onClick={retry.onClick}>{retry.label}</Button>}
  </div>
}

function retryAction(api: ForgeApi | undefined, statusError: string | null, check: () => void, sync: (forge: ForgeApi) => void): NoticeProps['retry'] {
  if (api === undefined) return undefined
  return statusError === null
    ? { label: 'Sync now', onClick: () => sync(api) }
    : { label: 'Check status', onClick: check }
}

function errorText(api: ForgeApi | undefined, status: ForgeMemberStatus | null, error: string | null): string | null {
  if (error !== null) return error
  return api === undefined ? 'Forge World status is unavailable.' : status?.error ?? null
}

function MemberGate(props: Props): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const api = window.dm.forge
  const { status, statusError, setStatusError } = useMemberStatus(api, props, attempt)
  const check = (): void => setAttempt(value => value + 1)
  const sync = (forge: ForgeApi): void => {
    setRetrying(true)
    void forge.sync(props.root).catch(error => setStatusError(errorMessage(error))).finally(() => {
      setRetrying(false)
      check()
    })
  }
  if (status?.readiness === 'removed') return <p className="forge-status" role="status">This project is no longer in the Forge World.</p>
  const ready = status?.readiness === 'ready'
  const banner = <ForgeNotice ready={ready} syncing={Boolean(status?.syncing) || retrying}
    error={errorText(api, status, statusError)} retry={retryAction(api, statusError, check, sync)} />
  const content = ready ? props.children : null
  return props.fullHeight ? <div className="forge-view">
    {banner}
    <div className="forge-view-content">{content}</div>
  </div> : <>{banner}{content}</>
}

export function ForgeOpen(props: Props): JSX.Element {
  return <MemberGate key={JSON.stringify([props.root, props.member, props.identity])} {...props} />
}
