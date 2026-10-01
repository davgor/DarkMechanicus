import type { DomainErrorCode, DomainErrorShape } from '../shared/domain/errors'

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }

  toShape(): DomainErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export function fail(
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new DomainError(code, message, details)
}

/** Maps any thrown value to the structured error contract; unknown failures become `internal`. */
export function toErrorShape(error: unknown): DomainErrorShape {
  if (error instanceof DomainError) {
    return error.toShape()
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'internal', message }
}
