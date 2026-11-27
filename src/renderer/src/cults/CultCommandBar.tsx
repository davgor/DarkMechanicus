/**
 * The Cult page's command bar: the cult's name, charter (collapsible), workspace and run state; the controls the run's
 * state allows (Start with per-run overrides, Pause or Resume, Stop and Kill now, each confirmed); the live countdown,
 * frozen while paused, or "Unlimited" with the running time; the cap with Raise; and the Past runs button.
 */
import { useState } from 'react'
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import type { CultView } from '../../../shared/cults/cult'
import type { CommandResult } from '../../../shared/desktop/api'
import { formatDuration, parseDuration, parseTimeLimit } from '../../../shared/cults/duration'
import { capIssue, MAX_CAP, shutdownTimingIssue } from '../../../shared/cults/runState'
import { ARCHETYPE_INFO } from '../../../shared/cults/archetypes'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { useNow } from '../epic/clock'
import { capRoom, controlsFor, countdownText, STATE_TEXT } from './cultPageModel'

interface CommandBarProps {
  cult: CultView
  run: CultRunDetail | null
  /** A run was started: the page loads the cult's runs again. */
  onStarted(): void
  pastOpen: boolean
  onTogglePast(): void
  /** The Plan Forge's target plan, named and linked; null for other archetypes. */
  target: JSX.Element | null
}

type Confirming = 'stop' | 'kill' | null

/** Runs a control and keeps its refusal to show; null once it went through. */
async function attempt(work: Promise<CommandResult<unknown>>, refuse: (message: string | null) => void): Promise<boolean> {
  const result = await work.catch((error: unknown) => ({ ok: false as const, error: { message: error instanceof Error ? error.message : String(error) } }))
  refuse(result.ok ? null : result.error.message)
  return result.ok
}

/** Who the cult is: its name, archetype, run state, workspace, target plan and the collapsible charter. */
function Identity({ cult, state, target }: { cult: CultView; state: keyof typeof STATE_TEXT; target: JSX.Element | null }): JSX.Element {
  return (
    <div className="cult-command-identity">
      <h1 className="cult-page-name">{cult.name}</h1>
      <span className="badge">{ARCHETYPE_INFO[cult.archetype].displayName}</span>
      <span className={`badge cult-run-state is-${state}`} aria-label={`State: ${STATE_TEXT[state]}`}>{STATE_TEXT[state]}</span>
      <span className="cult-workspace mono" title={cult.folderPath ?? undefined}>{cult.folderPath ?? 'Sanctum (no project)'}</span>
      {target}
      <details className="cult-charter">
        <summary>Charter</summary>
        <p>{cult.charter}</p>
      </details>
    </div>
  )
}

export function CultCommandBar({ cult, run, onStarted, pastOpen, onTogglePast, target }: CommandBarProps): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null)
  const live = run !== null && run.run.state !== 'ended' ? run : null
  return (
    <header className="cult-command-bar" aria-label="Cult commands">
      <Identity cult={cult} state={live?.run.state ?? 'idle'} target={target} />
      <div className="cult-command-controls">
        {live === null ? <StartControls cult={cult} onStarted={onStarted} refuse={setRefusal} /> : <RunControls run={live} refuse={setRefusal} />}
        <Button size="sm" aria-expanded={pastOpen} onClick={onTogglePast}>Past runs</Button>
      </div>
      {refusal === null ? null : <p className="cult-refusal" role="alert">{refusal}</p>}
    </header>
  )
}

/** Live running controls: the countdown, the cap with Raise, Pause or Resume, Stop and Kill now. */
function RunControls({ run, refuse }: { run: CultRunDetail; refuse(message: string | null): void }): JSX.Element {
  const [confirming, setConfirming] = useState<Confirming>(null)
  const controls = controlsFor(run.run.state)
  const id = run.run.id
  return (
    <>
      <Countdown run={run} />
      <CapControl run={run} canRaise={controls.raise} refuse={refuse} />
      {controls.pause ? <Button size="sm" icon="pause" onClick={() => void attempt(window.dm.cults.pause(id), refuse)}>Pause</Button> : null}
      {controls.resume ? <Button size="sm" variant="primary" onClick={() => void attempt(window.dm.cults.resume(id), refuse)}>Resume</Button> : null}
      {controls.stop ? <Button size="sm" onClick={() => setConfirming('stop')}>Stop</Button> : null}
      {controls.kill ? <Button size="sm" variant="danger" onClick={() => setConfirming('kill')}>Kill now</Button> : null}
      {confirming === null ? null : <ConfirmEnd kind={confirming} run={run} refuse={refuse} onClose={() => setConfirming(null)} />}
    </>
  )
}

const CONFIRM_TEXT = {
  stop: {
    title: 'Stop this run?',
    body: 'Graceful shutdown: the acolytes get their grace to finish and report, then the Magos writes the chronicle and the run ends.',
    action: 'Stop gracefully'
  },
  kill: {
    title: 'Kill this run now?',
    body: 'Every member’s terminal is ended at once. Nothing is wound down, reported or chronicled.',
    action: 'Kill now'
  }
} as const

function ConfirmEnd({ kind, run, refuse, onClose }: { kind: 'stop' | 'kill'; run: CultRunDetail; refuse(message: string | null): void; onClose(): void }): JSX.Element {
  const text = CONFIRM_TEXT[kind]
  const end = async (): Promise<void> => {
    onClose()
    await attempt(kind === 'stop' ? window.dm.cults.stop(run.run.id) : window.dm.cults.killNow(run.run.id), refuse)
  }
  return (
    <Dialog title={text.title} description={text.body} onClose={onClose}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={kind === 'kill' ? 'danger' : 'primary'} onClick={() => void end()}>{text.action}</Button>
      </>} />
  )
}

/** The time left, ticking only while running (so it stands still while paused), or Unlimited with the elapsed time. */
function Countdown({ run }: { run: CultRunDetail }): JSX.Element {
  const now = useNow()
  const paused = run.run.state === 'paused'
  return (
    <span className={`cult-countdown mono${paused ? ' is-frozen' : ''}`} role="timer" aria-label="Time left">
      {countdownText(run.run, now)}
      {paused ? <span className="cult-countdown-note"> (paused)</span> : null}
    </span>
  )
}

function CapControl({ run, canRaise, refuse }: { run: CultRunDetail; canRaise: boolean; refuse(message: string | null): void }): JSX.Element {
  const { cap } = run.run
  const [wanted, setWanted] = useState(String(Math.min(cap + 1, MAX_CAP)))
  const next = Number(wanted)
  const valid = Number.isInteger(next) && next > cap && next <= MAX_CAP
  return (
    <span className="cult-cap">
      <span className="mono">{`Cap ${cap}`}</span>
      {canRaise && capRoom(cap) > 0 ? (
        <>
          <input className="input mono cult-cap-input" type="number" min={cap + 1} max={MAX_CAP} value={wanted} aria-label="New cap"
            onChange={(event) => setWanted(event.target.value)} />
          <Button size="sm" disabled={!valid} onClick={() => void attempt(window.dm.cults.raiseCap(run.run.id, next), refuse)}>Raise</Button>
        </>
      ) : null}
    </span>
  )
}

interface Overrides {
  timeLimit: string
  unlimited: boolean
  cap: string
  acolyteGrace: string
  magosWindow: string
}

const overridesOf = (cult: CultView): Overrides => ({
  timeLimit: cult.defaultTimeLimitMs === null ? '' : formatDuration(cult.defaultTimeLimitMs),
  unlimited: cult.defaultTimeLimitMs === null,
  cap: String(cult.defaultCap),
  acolyteGrace: formatDuration(cult.acolyteGraceMs),
  magosWindow: formatDuration(cult.magosWindowMs)
})

type Parsed = { ok: true; overrides: Parameters<typeof window.dm.cults.start>[1] } | { ok: false; error: string }

function timing(text: string, label: string): number | string {
  const parsed = parseDuration(text)
  if (!parsed.ok) return `${label}: ${parsed.error}`
  return shutdownTimingIssue(parsed.ms) ?? parsed.ms
}

/** The run's overrides as Start sends them, or the first reason one is refused. */
function parseOverrides(form: Overrides): Parsed {
  const limit = form.unlimited ? { ok: true as const, ms: null } : parseTimeLimit(form.timeLimit)
  if (!limit.ok) return { ok: false, error: limit.error }
  const cap = Number(form.cap)
  const capError = capIssue(cap)
  if (capError !== null) return { ok: false, error: capError }
  const acolyteGraceMs = timing(form.acolyteGrace, 'Acolyte grace')
  const magosWindowMs = timing(form.magosWindow, 'Magos window')
  if (typeof acolyteGraceMs === 'string') return { ok: false, error: acolyteGraceMs }
  if (typeof magosWindowMs === 'string') return { ok: false, error: magosWindowMs }
  return { ok: true, overrides: { timeLimitMs: limit.ms, cap, acolyteGraceMs, magosWindowMs } }
}

function StartControls({ cult, onStarted, refuse }: { cult: CultView; onStarted(): void; refuse(message: string | null): void }): JSX.Element {
  const [form, setForm] = useState(() => overridesOf(cult))
  const [busy, setBusy] = useState(false)
  const parsed = parseOverrides(form)
  const change = (patch: Partial<Overrides>): void => setForm((previous) => ({ ...previous, ...patch }))
  const start = async (): Promise<void> => {
    if (!parsed.ok) return
    setBusy(true)
    const started = await attempt(window.dm.cults.start(cult.id, parsed.overrides), refuse)
    setBusy(false)
    if (started) onStarted()
  }
  return (
    <>
      <details className="cult-overrides">
        <summary>Run settings</summary>
        <OverrideFields form={form} change={change} />
        {parsed.ok ? null : <p className="field-error" role="alert">{parsed.error}</p>}
      </details>
      <Button size="sm" variant="primary" busy={busy} disabled={!parsed.ok} onClick={() => void start()}>Start</Button>
    </>
  )
}

function OverrideFields({ form, change }: { form: Overrides; change(patch: Partial<Overrides>): void }): JSX.Element {
  const field = (key: 'timeLimit' | 'cap' | 'acolyteGrace' | 'magosWindow', label: string, disabled = false): JSX.Element => (
    <label className="field cult-override">
      <span className="field-label">{label}</span>
      <input className="input mono" value={form[key]} disabled={disabled} onChange={(event) => change({ [key]: event.target.value })} />
    </label>
  )
  return (
    <div className="cult-override-fields">
      {field('timeLimit', 'Time limit', form.unlimited)}
      <label className="cult-check">
        <input type="checkbox" checked={form.unlimited} onChange={(event) => change({ unlimited: event.target.checked })} />
        Unlimited
      </label>
      {field('cap', 'Acolyte cap')}
      {field('acolyteGrace', 'Acolyte grace')}
      {field('magosWindow', 'Magos window')}
    </div>
  )
}
