import { describe, expect, it } from 'vitest'
import { DEV_CSP, PROD_CSP } from '../../../electron.vite.config'

/** The `img-src` directive of a policy string. */
function imgSrc(policy: string): string | undefined {
  return policy.split('; ').find((directive) => directive.startsWith('img-src '))
}

describe('renderer Content-Security-Policy', () => {
  it.each([
    ['production', PROD_CSP],
    ['development', DEV_CSP]
  ])('lets the %s window load chat images and nothing more', (_name, policy) => {
    expect(imgSrc(policy)).toBe("img-src 'self' data: dm-attachment: dm-chat-image:")
    expect(policy).toContain("default-src 'self'")
    expect(policy.match(/dm-chat-image:/g)).toHaveLength(1)
  })
})
