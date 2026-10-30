/** Reading what an ACP agent sends: JSON values of unknown shape, and text cut to a size the transcript holds. */
import { clipMasked } from '../../claimTokenMask'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** `text` cut to `max` with an ellipsis, claim tokens masked first so a cut inside one cannot leave part of its secret. */
export function clip(text: string, max: number): string {
  return clipMasked(text, max)
}
