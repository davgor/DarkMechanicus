import type { CommandResult } from '../../../shared/desktop/api'
import { CommandError } from '../api/dm'

/** The data of a chat call, or a thrown `CommandError` carrying the failure's code and message. */
export async function unwrapChat<T>(call: Promise<CommandResult<T>>): Promise<T> {
  const result = await call
  if (result.ok) {
    return result.data
  }
  throw new CommandError(result.error)
}
