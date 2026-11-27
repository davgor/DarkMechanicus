import { expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from '../agents/claimTokenMask'
import { GRANT_TOKEN_MASK } from '../../core/storedSecrets'
import { maskAgentChatSecretsDeep } from './secretMask'

const grant = 'dmg_' + 'a1'.repeat(32)
const attempt = 'at_' + '0'.repeat(26) + '.' + 's'.repeat(32)
const kanban = 'ka_' + '1'.repeat(26) + '.' + 'k'.repeat(32)

it('masks grant and both claim token forms in nested strings and keys without mutating input', () => {
  const original = { detail: `before ${grant} ${attempt} ${kanban} after`, nested: [null, 7, true, { [grant]: [attempt, kanban, grant] }] }
  const before = JSON.stringify(original)
  expect(maskAgentChatSecretsDeep(original)).toEqual({
    detail: `before ${GRANT_TOKEN_MASK} ${CLAIM_TOKEN_MASK} ${CLAIM_TOKEN_MASK} after`,
    nested: [null, 7, true, { [GRANT_TOKEN_MASK]: [CLAIM_TOKEN_MASK, CLAIM_TOKEN_MASK, GRANT_TOKEN_MASK] }]
  })
  expect(JSON.stringify(original)).toBe(before)
})

it('handles truncated and uppercase grants, primitive values and non-plain objects', () => {
  expect(maskAgentChatSecretsDeep('DMG_' + 'AB'.repeat(8))).toBe(GRANT_TOKEN_MASK)
  expect(maskAgentChatSecretsDeep('dmg_' + 'a'.repeat(15))).toBe('dmg_' + 'a'.repeat(15))
  const date = new Date(0)
  expect(maskAgentChatSecretsDeep(date)).toBe(date)
  expect(maskAgentChatSecretsDeep(undefined)).toBeUndefined()
})
