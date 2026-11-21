import { useEffect, useState } from 'react'
import { Dialog } from '../components/Dialog'

export function Notifications(): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <button className="footer-link" onClick={() => setOpen(true)}>Notifications</button>
    {open && <Settings close={() => setOpen(false)} />}
  </>
}

function useTelegramStatus(onError: (message: string) => void) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.dm.telegramStatus>>>()
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const next = await window.dm.telegramStatus()
        if (active) setStatus(next)
      } catch { if (active) onError('Could not load notification settings.') }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { active = false; clearInterval(timer) }
  }, [onError])
  return [status, setStatus] as const
}

function statusLabel(status?: { configured: boolean; paired: boolean }): string {
  if (status?.paired) return 'Recipient paired'
  return status?.configured ? 'Token configured, awaiting pairing' : 'Connect your bot to receive agent questions.'
}

function Settings({ close }: { close(): void }): JSX.Element {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useTelegramStatus(setError)
  async function pair(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setCode(await window.dm.pairTelegram())
      setStatus({ configured: true, paired: false, issue: '' })
    } catch { setError('Could not configure Telegram. Check your token, network, and OS credential store.') }
    finally { setBusy(false) }
  }
  return <Dialog title="Notifications" onClose={close} actions={<button onClick={close}>Close</button>}>
    <details open><summary>Telegram</summary>
      <p>{statusLabel(status)}</p>
      <p>Copy your BotFather token, then select Pair from clipboard.</p>
      <button disabled={busy} onClick={() => void pair()}>Pair from clipboard</button>
      {code && !status?.paired && <p>Send <code>/start {code}</code> in your private bot chat within ten minutes.</p>}
      {status?.issue && <p role="status">{status.issue}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  </Dialog>
}
