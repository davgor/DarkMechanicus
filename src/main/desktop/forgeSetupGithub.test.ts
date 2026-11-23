import { expect, it, vi } from 'vitest'
import { discoverGithubForgeSetup } from './forgeSetupGithub'

it.each(['header', 'stream'] as const)('rejects a %s-over-limit descriptor even when cancelling its body fails', async (limit) => {
  const cancel = vi.fn(async () => { throw new Error('The stream closed while cancelling') })
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(33 * 1024)) },
    cancel
  })
  const headers = limit === 'header' ? { 'content-length': '33792' } : undefined
  const fetch = vi.fn(async () => new Response(body, { headers }))
  const repository = 'https://github.com/example/project.git'
  const result = await discoverGithubForgeSetup(repository, { getAccount: () => null, getToken: () => null }, fetch)
  expect(result).toMatchObject({ status: 'unavailable', source: null, facts: [] })
  expect(fetch).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
})
