import { useRef, useState } from 'react'
import type { BrowserApi, BrowserState } from '../../../shared/browser/browserApi'
import type { CommandResult } from '../../../shared/desktop/api'
import { useBrowser } from './useBrowser'
import '../agentChat/pendingPrompt.css'
import './originPrompt.css'

type PendingOrigin = NonNullable<BrowserState['pendingOrigin']>
type Decision = 'once' | 'always' | 'deny'

const DECISIONS: readonly { decision: Decision; label: string }[] = [
  { decision: 'once', label: 'Allow once' },
  { decision: 'always', label: 'Always allow' },
  { decision: 'deny', label: 'Deny' }
]
const STALE_TEXT = 'This site prompt is no longer pending.'
const SEND_FAILED = 'The answer could not be sent. Please try again.'

/** A line left where the card was: a stale answer's, or an `always` whose site could not be saved. */
interface Notice { promptId: string; text: string; alert: boolean }

/**
 * Who asked, as the card's heading begins (red-team Fix 50, R19-1): the page's own navigation says so, an agent's ask
 * names the browser's owner label, and the person's own reads as theirs.
 */
function asker(pending: PendingOrigin, ownerLabel: string | null): string {
  if (pending.requestedBy === 'page') return 'This page wants to open'
  if (pending.requestedBy === 'person') return 'You asked to open'
  return `${ownerLabel ?? 'An agent'} wants to open`
}

/** The origin's scheme, host and port as plain text (the port the scheme implies when it names none); null if unparsable. */
function parts(origin: string): string | null {
  try {
    const url = new URL(origin)
    const scheme = url.protocol.replace(/:$/, '')
    const port = url.port || (scheme === 'https' ? '443' : '80')
    return `Scheme: ${scheme} · Host: ${url.hostname} · Port: ${port}`
  } catch {
    return null
  }
}

/** What an answer leaves: the card closed with an optional notice in its place, or the card kept with an error. */
type Outcome = { closed: true; notice: Notice | null } | { closed: false; error: string }

/**
 * A stale answer closes the card with a notice, and so does an Always allow whose save failed (the folder's site cap,
 * say): main has already cleared the prompt without loading the page and answers that error to this call (DM-870).
 * Any other failure keeps the card.
 */
function outcomeOf(prompt: PendingOrigin, decision: Decision, result: CommandResult<null>): Outcome {
  if (result.ok) return { closed: true, notice: null }
  if (result.error.code === 'stale_prompt') return { closed: true, notice: { promptId: prompt.id, text: STALE_TEXT, alert: false } }
  if (decision !== 'always') return { closed: false, error: result.error.message }
  const text = `Couldn't save ${prompt.origin} to Always allow, so the page did not open: ${result.error.message}`
  return { closed: true, notice: { promptId: prompt.id, text, alert: true } }
}

/**
 * The chat's pending site prompt, docked above its composer below any agent approval card: who asked to open which
 * origin, with Allow once, Always allow and Deny. It never takes focus on arrival.
 */
export function OriginPromptCard({ folder, chatId, api }: { folder: string | null; chatId: string; api: BrowserApi }): JSX.Element | null {
  const { state } = useBrowser(folder, chatId, api)
  const [answered, setAnswered] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const pending = state?.pendingOrigin ?? null
  const shown = pending !== null && pending.id !== answered ? pending : null

  async function decide(prompt: PendingOrigin, decision: Decision): Promise<string | null> {
    const outcome = await api.decideOrigin({ folder, chatId, promptId: prompt.id, decision }).then(
      (result) => outcomeOf(prompt, decision, result), (): Outcome => ({ closed: false, error: SEND_FAILED }))
    if (!outcome.closed) return outcome.error
    setAnswered(prompt.id)
    setNotice(outcome.notice)
    return null
  }

  return (
    <>
      <NoticeLine notice={notice} pendingId={pending?.id ?? null} />
      {shown !== null && <Card key={shown.id} pending={shown} ownerLabel={state?.ownerLabel ?? null} decide={decide} />}
    </>
  )
}

/**
 * The line left where an answered card was: a status, or an alert when Always allow could not save the site. It
 * belongs to its prompt, so the next prompt's card replaces it.
 */
function NoticeLine({ notice, pendingId }: { notice: Notice | null; pendingId: string | null }): JSX.Element | null {
  if (notice === null || (pendingId !== null && pendingId !== notice.promptId)) return null
  return (
    <p className={notice.alert ? 'agent-prompt-notice agent-prompt-error' : 'agent-prompt-notice'} role={notice.alert ? 'alert' : 'status'}>
      {notice.text}
    </p>
  )
}

/** One prompt's card: its buttons stand down while an answer is in flight, and a failed one shows its error here. */
function Card({ pending, ownerLabel, decide }: {
  pending: PendingOrigin
  ownerLabel: string | null
  decide(prompt: PendingOrigin, decision: Decision): Promise<string | null>
}): JSX.Element {
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function choose(decision: Decision): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    const failure = await decide(pending, decision)
    locked.current = false
    setBusy(false)
    setError(failure)
  }
  const detail = parts(pending.origin)
  return (
    <section className="agent-prompt origin-prompt glass" role="alertdialog" aria-label={pending.origin} aria-busy={busy}>
      <h3>{asker(pending, ownerLabel)} <span className="origin-prompt-origin">{pending.origin}</span></h3>
      {detail !== null && <p className="agent-prompt-detail">{detail}</p>}
      {error !== null && <p className="agent-prompt-error" role="alert">{error}</p>}
      <div className="agent-prompt-options">
        {DECISIONS.map(({ decision, label }) => (
          <button key={decision} className="btn" type="button" disabled={busy} onClick={() => { void choose(decision) }}>{label}</button>
        ))}
      </div>
    </section>
  )
}
