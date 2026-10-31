import type { AgentDownloadResult, AgentFindResult, AgentSignInResult, AgentView } from '../../../shared/desktop/api'

/** What an agent action came to, ready to show inline where it was started. */
export interface AgentOutcome {
  tone: 'ok' | 'warn' | 'error'
  title: string
  detail: string | null
  /** The installer's last output lines (only a failed download has any). */
  output: readonly string[]
}

const outcome = (tone: AgentOutcome['tone'], title: string, detail: string | null = null, output: readonly string[] = []): AgentOutcome => ({
  tone,
  title,
  detail,
  output
})

/** A built-in's version follows its name; a custom CLI's is labelled with the agent name its handshake reported. */
function withVersion(verb: string, name: string, agent: AgentView): string {
  if (agent.version === null) {
    return `${verb} ${name}`
  }
  return agent.reportedName === null ? `${verb} ${name} ${agent.version}` : `${verb} ${name} (${agent.reportedName} ${agent.version})`
}

/** Null when the person closed the file dialog: nothing happened, so there is nothing to say. */
export function findOutcome(name: string, result: AgentFindResult): AgentOutcome | null {
  switch (result.outcome) {
    case 'connected':
      return outcome('ok', withVersion('Connected', name, result.agent))
    case 'cancelled':
      return null
    case 'refused':
      return outcome('error', 'Not connected', result.reason)
  }
}

/** What editing a custom CLI came to; null when the person closed the file dialog of a repick, which changed nothing. */
export function editOutcome(name: string, result: AgentFindResult): AgentOutcome | null {
  switch (result.outcome) {
    case 'connected':
      return outcome('ok', withVersion('Saved', name, result.agent))
    case 'cancelled':
      return null
    case 'refused':
      return outcome('error', 'Not saved', result.reason)
  }
}

export function downloadOutcome(name: string, result: AgentDownloadResult): AgentOutcome {
  switch (result.outcome) {
    case 'installed':
      return outcome('ok', withVersion(result.updated ? 'Updated' : 'Installed', name, result.agent))
    case 'cancelled':
      return outcome('warn', 'Download cancelled', 'Nothing was downloaded or changed.')
    case 'failed':
      return outcome('error', 'Download failed', result.reason, result.output)
  }
}

export function signInOutcome(result: AgentSignInResult): AgentOutcome {
  if (result.outcome === 'started') {
    return outcome(
      'ok',
      'Sign-in started',
      'Finish signing in in the terminal window that opened. This updates here once you are signed in.'
    )
  }
  return outcome('error', 'Could not start sign-in', result.reason)
}
