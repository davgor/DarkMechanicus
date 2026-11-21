import { expect, it } from 'vitest'
import { publishForgeRepository } from './forgePublish'

it('creates an initialized private repository and reports permission errors without leaking credentials', async () => {
  const sent: Request[] = []
  let status = 201
  const request: typeof fetch = async (url, options) => {
    sent.push(new Request(url, options))
    return new Response(null, { status })
  }
  await expect(publishForgeRepository('tickets', null, request)).rejects.toThrow('Sign into GitHub')
  expect(sent).toHaveLength(0)
  await publishForgeRepository('tickets', 'test-credential', request)
  expect(sent[0].url).toBe('https://api.github.com/user/repos')
  expect(sent[0].method).toBe('POST')
  expect(sent[0].headers.get('Authorization')).toBe('Bearer test-credential')
  expect(await sent[0].json()).toEqual({ name: 'tickets', private: true, auto_init: true })
  status = 403
  await expect(publishForgeRepository('tickets', 'test-credential', request)).rejects.toThrow(/^GitHub could not create this private repository \(403\)\.$/)
})
