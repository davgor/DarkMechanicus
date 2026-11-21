import { useEffect, useState } from 'react'
import { Dialog } from '../components/Dialog'

export function Notifications(): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <button className="footer-link" onClick={() => setOpen(true)}>Notifications</button>
    {open && <Settings close={() => setOpen(false)} />}
  </>
}

function Settings({ close }: { close(): void }): JSX.Element {
  const [token, setToken] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.dm.telegramStatus>>>()
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const next = await window.dm.telegramStatus()
        if (active) setStatus(next)
      } catch { if (active) setError('Could not load notification settings.') }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  async function pair(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setCode(await window.dm.pairTelegram(token.trim()))
      setToken('')
      setStatus({ configured: true, paired: false, issue: '' })
    } catch { setError('Could not configure Telegram. Check your token, network, and OS credential store.') }
    finally { setBusy(false) }
  }
  return <Dialog title="Notifications" onClose={close} actions={<button onClick={close}>Close</button>}>
    <details open><summary>Telegram</summary>
      <p>{status?.paired ? 'Recipient paired' : status?.configured ? 'Token configured · awaiting pairing' : 'Connect your bot to receive agent questions.'}</p>
      <label>Bot token <input type="password" autoComplete="off" value={token} placeholder={status?.configured ? '••••••••' : ''} onChange={e => setToken(e.target.value)} /></label>
      <button disabled={!token.trim() || busy} onClick={() => void pair()}>{status?.configured ? 'Replace and pair' : 'Pair bot'}</button>
      {code && !status?.paired && <p>Send <code>/start {code}</code> in your private bot chat within ten minutes.</p>}
      {status?.issue && <p role="status">{status.issue}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  </Dialog>
}
