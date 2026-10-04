import type { CommandName } from '../../../shared/domain/api'
import type { DomainErrorCode } from '../../../shared/domain/errors'
import type { CommandInput, CommandOutput } from '../../../shared/desktop/api'
import { CommandError, errorMessage, runCommand } from '../api/dm'

/** A command invoker bound to one tracked folder. */
export type Runner = <K extends CommandName>(name: K, input: CommandInput<K>) => Promise<CommandOutput<K>>

export function bindRunner(folder: string): Runner {
  return (name, input) => runCommand(folder, name, input)
}

export interface Failure {
  code: DomainErrorCode | null
  message: string
  /** What the core's error carried beside its message; absent when it carried nothing. */
  details?: Record<string, unknown>
}

export function failureOf(error: unknown): Failure {
  if (!(error instanceof CommandError)) {
    return { code: null, message: errorMessage(error) }
  }
  const failure: Failure = { code: error.code, message: error.message }
  return error.details === undefined ? failure : { ...failure, details: error.details }
}

/** Splits "Dependency not added. DM-203 is in…" into a bold lead sentence and the rest. */
export function splitLead(message: string): { lead: string; rest: string } {
  const stop = message.indexOf('. ')
  return stop < 0 ? { lead: '', rest: message } : { lead: message.slice(0, stop + 1), rest: message.slice(stop + 2) }
}
