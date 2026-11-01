import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitErrorShape } from '../../../shared/git/api'
import type { GithubAccountView } from '../../../shared/github/api'
import { useLatest } from '../app/useLatest'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'

type Phase = { kind: 'idle' } | { kind: 'signing-in' } | { kind: 'failed'; failure: GitErrorShape }

const UNEXPECTED: GitErrorShape = { code: 'github_failed', message: 'GitHub sign-in failed unexpectedly.' }

const GH_DOWNLOAD_URL = 'https://cli.github.com'

/** The command that fixes a gh login, by failure code. */
const FIX_COMMANDS: Partial<Record<string, string>> = {
  gh_not_signed_in: 'gh auth login',
  gh_missing_scope: 'gh auth refresh -h github.com -s repo,workflow'
}

interface SignInDialogProps {
  onClose(): void
  onSignedIn(account: GithubAccountView): void
}

/** Runs one sign-in at a time; an answer after the dialog closed is dropped (main still broadcasts a success). */
function useSignIn(onSignedIn: (account: GithubAccountView) => void): { phase: Phase; start(): void } {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const signedIn = useLatest(onSignedIn)
  const live = useRef(true)
  const running = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const finish = useCallback((next: Phase | GithubAccountView) => {
    running.current = false
    if (!live.current) return
    if ('kind' in next) setPhase(next)
    else signedIn.current(next)
  }, [signedIn])
  const start = useCallback(() => {
    if (running.current) return
    running.current = true
    setPhase({ kind: 'signing-in' })
    window.github.signIn().then(
      (result) => finish(result.ok ? result.data : { kind: 'failed', failure: result.error }),
      () => finish({ kind: 'failed', failure: UNEXPECTED })
    )
  }, [finish])
  return { phase, start }
}

function FixCommand({ command }: { command: string }): JSX.Element {
  return (
    <div className="sign-in-fix">
      <code>{command}</code>
      <Button size="sm" icon="copy" onClick={() => void window.dm.copyText(command)}>
        Copy
      </Button>
    </div>
  )
}

function Failure({ failure }: { failure: GitErrorShape }): JSX.Element {
  if (failure.code === 'gh_not_installed') {
    return (
      <div className="sign-in-failure" role="alert">
        <p>GitHub CLI isn't installed.</p>
        <Button size="sm" onClick={() => void window.dm.openExternal(GH_DOWNLOAD_URL)}>
          Get the GitHub CLI
        </Button>
      </div>
    )
  }
  const command = FIX_COMMANDS[failure.code]
  return (
    <div className="sign-in-failure" role="alert">
      <p>{failure.message}</p>
      {command === undefined ? null : <FixCommand command={command} />}
    </div>
  )
}

/** Signs in with this computer's GitHub CLI login when the person asks; Cancel only closes. */
export function SignInDialog({ onClose, onSignedIn }: SignInDialogProps): JSX.Element {
  const { phase, start } = useSignIn(onSignedIn)
  const failed = phase.kind === 'failed'
  const actions = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" busy={phase.kind === 'signing-in'} onClick={start}>
        {failed ? 'Try again' : 'Use my GitHub CLI login'}
      </Button>
    </>
  )
  return (
    <Dialog title="Sign in to GitHub" onClose={onClose} actions={actions}>
      <div className="sign-in-body">
        <p>
          Dark Mechanicus signs in with this computer's GitHub CLI login (<code>gh</code>). It keeps an encrypted copy
          of the token.
        </p>
        {phase.kind === 'signing-in' ? (
          <p className="sign-in-status" aria-live="polite">
            <span className="sign-in-spinner" aria-hidden="true" />
            <span>Signing in with the GitHub CLI login…</span>
          </p>
        ) : null}
        {failed ? <Failure failure={phase.failure} /> : null}
      </div>
    </Dialog>
  )
}
