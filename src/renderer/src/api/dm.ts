import type { CommandName } from '../../../shared/domain/api'
import type { DomainErrorCode, DomainErrorShape } from '../../../shared/domain/errors'
import type { CommandInput, CommandOutput } from '../../../shared/desktop/api'

/** A structured command failure surfaced to UI code (code + human message). */
export class CommandError extends Error {
  readonly code: DomainErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(shape: DomainErrorShape) {
    super(shape.message)
    this.name = 'CommandError'
    this.code = shape.code
    this.details = shape.details
  }
}

/** Invokes a core command for a tracked folder; resolves with data or throws CommandError. */
export async function runCommand<K extends CommandName>(
  folder: string,
  name: K,
  input: CommandInput<K>
): Promise<CommandOutput<K>> {
  const result = await window.dm.command(folder, name, input)
  if (result.ok) {
    return result.data
  }
  throw new CommandError(result.error)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
