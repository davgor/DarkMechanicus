import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'

export function Notifications(): JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <div className="footer-line">
      <Icon name="bell" size={15} />
      <button type="button" className="footer-link" onClick={() => setOpen(true)}>Notifications</button>
    </div>
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
      setStatus({ configured: true, enabled: true, paired: false, issue: '' })
    } catch { setError('Could not configure Telegram. Check your token, network, and OS credential store.') }
    finally { setBusy(false) }
  }
  async function toggle(): Promise<void> {
    if (!status) return
    setBusy(true)
    setError('')
    try {
      await window.dm.setTelegramEnabled(!status.enabled)
      setStatus(await window.dm.telegramStatus())
    } catch { setError('Could not change Telegram notifications.') }
    finally { setBusy(false) }
  }
  const paired = status?.paired === true
  return <Dialog title="Notifications" description="Agents can reach you on Telegram when they need your answer and you are away from their conversation."
    onClose={close} actions={<Button onClick={close}>Close</Button>}>
    <section aria-label="Telegram" className="telegram-settings">
      <TelegramSwitch status={status} busy={busy} onToggle={() => void toggle()} />
      {!paired && <p>Copy your BotFather token, then pair the bot with your private chat.</p>}
      <Button size="sm" busy={busy} onClick={() => void pair()}>{paired ? 'Pair another bot from clipboard' : 'Pair from clipboard'}</Button>
      {code && !paired && <p>Send <code>/start {code}</code> in your private bot chat within ten minutes.</p>}
      {status?.issue && <p role="status">{status.issue}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </Dialog>
}


function TelegramSwitch({ status, busy, onToggle }: {
  status: Awaited<ReturnType<typeof window.dm.telegramStatus>> | undefined
  busy: boolean
  onToggle(): void
}): JSX.Element {
  return <div className="telegram-channel">
        <div><h3>Telegram</h3><p role="status">{statusLabel(status)}</p></div>
        <button type="button" role="switch" aria-label="Telegram notifications" aria-checked={!!status?.enabled}
          className="telegram-switch" disabled={!status?.configured || busy} onClick={() => onToggle()} />
      </div>
}
