/**
 * The `dm-shrine:` protocol (DM-632 c2): it serves only the Shrine a known run recorded, checked again on each read; it
 * refuses every other address (a path, another host, an extra segment, a query) and every run without a Shrine; HTML is
 * sent with the stated CSP, an image with a script-free policy; and the scheme is registered standard and secure, so a
 * sandboxed frame of it has an opaque origin of its own.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CultRunView } from '../../shared/cults/cult'
import { SHRINE_HTML_CSP, shrineUrl } from '../../shared/cults/shrine'
import { createShrineLookup, handleShrineRequest, parseShrineUrl, registerShrineProtocol, registerShrineScheme } from './shrineProtocol'

const RUN = 'cr_01m8shrine000000000000000a'
const OTHER = 'cr_01m8shrine000000000000000b'

let root: string
let work: string
const runs = new Map<string, Pick<CultRunView, 'workDir' | 'shrinePath'>>()
const lookup = createShrineLookup((runId) => runs.get(runId) ?? null)
const get = (url: string, method = 'GET') => handleShrineRequest(new Request(url, { method }), lookup)

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-shrine-protocol-')))
  work = join(root, 'work')
  mkdirSync(work)
  writeFileSync(join(work, 'index.html'), '<h1>Gerry</h1><script>parent.postMessage(1, "*")</script>')
  writeFileSync(join(work, 'plant.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  writeFileSync(join(root, 'secret.png'), 'secret')
  runs.clear()
  runs.set(RUN, { workDir: work, shrinePath: join(work, 'index.html') })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('dm-shrine addresses', () => {
  it('names a run and a revision, never a path', () => {
    expect(shrineUrl(RUN, '3')).toBe(`dm-shrine://shrine/${RUN}/3`)
    expect(parseShrineUrl(shrineUrl(RUN, '3'))).toEqual({ runId: RUN, revision: '3' })
  })

  it.each([
    ['another scheme', `dm-attachment://shrine/${RUN}/1`],
    ['another host', `dm-shrine://${RUN}/1`],
    ['a path as the run', `dm-shrine://shrine/..%2F..%2Fetc%2Fpasswd/1`],
    ['a traversal', `dm-shrine://shrine/${RUN}/../../secret.png`],
    ['an extra segment', `dm-shrine://shrine/${RUN}/1/more`],
    ['no revision', `dm-shrine://shrine/${RUN}`],
    ['a query', `dm-shrine://shrine/${RUN}/1?path=/etc/passwd`],
    ['not a URL', 'not a url']
  ])('refuses %s', (_name, url) => {
    expect(parseShrineUrl(url)).toBeNull()
  })
})

describe('dm-shrine requests', () => {
  it('serves the run\'s HTML Shrine with the stated CSP, nosniff and no caching', async () => {
    const response = await get(shrineUrl(RUN, '1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toBe(SHRINE_HTML_CSP)
    expect(SHRINE_HTML_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:")
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toContain('<h1>Gerry</h1>')
  })

  it('serves an SVG as an image with a policy that runs no script', async () => {
    runs.set(RUN, { workDir: work, shrinePath: join(work, 'plant.svg') })
    const response = await get(shrineUrl(RUN, '2'))
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml')
    const csp = response.headers.get('Content-Security-Policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('script-src')
    expect(csp).toContain('sandbox')
  })

  it('answers 404 for a run that is unknown, has no Shrine, or whose recorded path is not its own Shrine', async () => {
    expect((await get(shrineUrl(OTHER, '1'))).status).toBe(404)
    runs.set(OTHER, { workDir: work, shrinePath: null })
    expect((await get(shrineUrl(OTHER, '1'))).status).toBe(404)
    // A record pointing outside its work dir (never written by publish) is still refused at read.
    runs.set(OTHER, { workDir: work, shrinePath: join(root, 'secret.png') })
    expect((await get(shrineUrl(OTHER, '1'))).status).toBe(404)
    runs.set(OTHER, { workDir: work, shrinePath: join(work, 'missing.png') })
    expect((await get(shrineUrl(OTHER, '1'))).status).toBe(404)
  })

  it('answers 404 for a malformed address and 405 for any method but GET', async () => {
    expect((await get(`dm-shrine://shrine/${RUN}/1/../../secret.png`)).status).toBe(404)
    expect((await get(`dm-shrine://other/${RUN}/1`)).status).toBe(404)
    const post = await get(shrineUrl(RUN, '1'), 'POST')
    expect(post.status).toBe(405)
    expect(post.headers.get('Allow')).toBe('GET')
  })
})

describe('registerShrineScheme and registerShrineProtocol', () => {
  it('registers dm-shrine as a standard, secure scheme', () => {
    const registerSchemesAsPrivileged = vi.fn()
    registerShrineScheme({ registerSchemesAsPrivileged } as never)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([{ scheme: 'dm-shrine', privileges: { standard: true, secure: true } }])
  })

  it('answers the scheme with the lookup-backed handler', async () => {
    const handle = vi.fn()
    registerShrineProtocol({ handle } as never, lookup)
    expect(handle).toHaveBeenCalledWith('dm-shrine', expect.any(Function))
    const [, handler] = handle.mock.calls[0] as [string, (request: Request) => Promise<Response>]
    expect((await handler(new Request(shrineUrl(RUN, '1')))).status).toBe(200)
  })
})
