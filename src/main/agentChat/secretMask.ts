import { GRANT_TOKEN, GRANT_TOKEN_MASK } from '../../core/storedSecrets'
import { maskClaimTokensDeep } from '../agents/claimTokenMask'

function maskGrants(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(GRANT_TOKEN, GRANT_TOKEN_MASK)
  if (Array.isArray(value)) return value.map(maskGrants)
  if (typeof value === 'object' && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(GRANT_TOKEN, GRANT_TOKEN_MASK), maskGrants(item)]))
    }
  }
  return value
}

/** Mask before storing or pushing any chat payload, including status details and stderr tails. */
export function maskAgentChatSecretsDeep<T>(value: T): T {
  return maskGrants(maskClaimTokensDeep(value)) as T
}
