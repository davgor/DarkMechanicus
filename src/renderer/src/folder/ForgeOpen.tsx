import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '../components/Button'

export function ForgeOpen({ root, children }: { root: string; children: ReactNode }): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void window.dm.forge!.sync(root).then(() => {
      if (current) setReady(true)
    }).catch(e => { if (current) setError(String(e)) })
    return () => { current = false }
  }, [root, attempt])
  if (ready) return <>{children}</>
  return <div className="home" role="status">{error || 'Syncing Forge World tickets…'}
    {error && <Button onClick={() => { setError(''); setAttempt(n => n + 1) }}>Retry sync</Button>}
  </div>
}
