/** Claim-token syntax shared by transcript attribution and main-private spawn extraction. */
export const CLAIM_TOKEN = /(?<![A-Za-z0-9_])(at_[0-9a-hjkmnp-tv-z]{26})\.[A-Za-z0-9_-]{6,}/g

/** Historical attribution: one distinct attempt id, or null for none or several. */
export function claimedAttemptId(text: string): string | null {
  const ids = new Set([...text.matchAll(CLAIM_TOKEN)].map((match) => match[1] ?? ''))
  return ids.size === 1 ? ([...ids][0] ?? null) : null
}
