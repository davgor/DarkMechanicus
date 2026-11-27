import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BrowserControlError, browserErrorCodeSchema, browserFailure, type BrowserOperation, type BrowserReply
} from '../../shared/browser/browserControl'
import type { SessionRole } from '../../shared/domain/views'
import { pngBytes } from '../../test/images'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { MAX_IMAGE_BYTES } from '../attachments/intake'
import { createBrowserClient, type BrowserClient } from '../desktop/browserClient'
import { DomainError } from '../errors'
import type { Workspace } from '../workspace'

const TAB = { url: 'https://example.com/', title: 'Example', loading: false }
const IMAGE = { id: 'ci_01h2xcejqtf2nbrexx3vqjhp41', width: 64, height: 48, bytes: 33, mime: 'image/png' as const }

interface FakeBrowser extends BrowserClient {
  sent: BrowserOperation[]
}

/** Answers every op with `answer(op)`, recording what was sent. */
function fakeBrowser(answer: (operation: BrowserOperation) => BrowserReply): FakeBrowser {
  const sent: BrowserOperation[] = []
  return {
    sent,
    request: (operation) => {
      sent.push(operation)
      return Promise.resolve(answer(operation))
    }
  }
}

function ok(data: Extract<BrowserReply, { ok: true }>['data']): BrowserReply {
  return { version: 1, requestId: 'r-1', ok: true, data }
}

const STATUS = { enabled: true, owner: 'agent' as const, tab: TAB, pendingOrigin: null }
const READ = { url: TAB.url, title: TAB.title, untrusted: true as const, content: 'Example text', truncated: false }

/** What the fake desktop answers for each op other than a screenshot. */
function answerFor(operation: BrowserOperation): BrowserReply {
  if (operation.op === 'browser_status') return ok(STATUS)
  if (operation.op === 'browser_read') return ok(READ)
  return ok({ tab: TAB })
}

async function failureOf(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof DomainError) return error
    throw error
  }
  throw new Error('Expected the command to fail.')
}

type Call = [name: string, run: (workspace: Workspace) => Promise<unknown>, sent: BrowserOperation, result: unknown]

const CALLS: Call[] = [
  ['browserStatus', (w) => w.browserStatus({}), { op: 'browser_status', args: {} }, STATUS],
  ['browserNavigate', (w) => w.browserNavigate({ url: 'https://example.com/', as: 'Acolyte:DM-867' }),
    { op: 'browser_navigate', args: { url: 'https://example.com/', as: 'Acolyte:DM-867' } }, { tab: TAB }],
  ['browserClick', (w) => w.browserClick({ ref: 'e12' }), { op: 'browser_click', args: { ref: 'e12' } }, { tab: TAB }],
  ['browserType', (w) => w.browserType({ ref: 'e3', text: 'hello', submit: true }),
    { op: 'browser_type', args: { ref: 'e3', text: 'hello', submit: true } }, { tab: TAB }],
  ['browserPress', (w) => w.browserPress({ key: 'Enter' }), { op: 'browser_press', args: { key: 'Enter' } }, { tab: TAB }],
  ['browserRead', (w) => w.browserRead({ mode: 'tree', maxChars: 2000 }), { op: 'browser_read', args: { mode: 'tree', maxChars: 2000 } }, READ]
]

let harness: Harness

beforeEach(async () => {
  harness = createHarness()
  await harness.open('desktop').initializeRepository({ name: 'browser-repo' })
})

afterEach(() => {
  harness.cleanup()
})

describe('browser commands', () => {
  it.each(CALLS)('%s sends its op and args and answers with the reply data', async (_name, run, sent, result) => {
    const browser = fakeBrowser(answerFor)
    expect(await run(harness.open('worker', { browserClient: browser }))).toEqual(result)
    expect(browser.sent).toEqual([sent])
  })

  it.each<SessionRole>(['worker', 'orchestrator'])('lets a %s session drive the browser', async (role) => {
    const browser = fakeBrowser(answerFor)
    const workspace = harness.open(role, { browserClient: browser })
    for (const [, run] of CALLS) await run(workspace)
    expect(browser.sent.map((operation) => operation.op)).toEqual(CALLS.map(([, , sent]) => sent.op))
  })

  it.each<SessionRole>(['planner', 'reviewer', 'reader', 'desktop'])('refuses a %s session before anything is sent', async (role) => {
    const browser = fakeBrowser(answerFor)
    const workspace = harness.open(role, { browserClient: browser })
    for (const [, run] of [...CALLS, ['browserScreenshot', (w: Workspace) => w.browserScreenshot({})] as const]) {
      const error = await failureOf(run(workspace))
      expect(error.code).toBe('unauthorized')
      expect(error.message).toContain('browser.drive')
    }
    expect(browser.sent).toEqual([])
  })

  it('refuses the desktop transport even for a role that holds browser.drive', async () => {
    const browser = fakeBrowser(answerFor)
    const workspace = harness.open('worker', { transport: 'desktop', browserClient: browser })
    for (const [, run] of CALLS) {
      expect((await failureOf(run(workspace))).code).toBe('unauthorized')
    }
    expect((await failureOf(workspace.browserScreenshot({}))).code).toBe('unauthorized')
    expect(browser.sent).toEqual([])
  })
})

describe('browser commands: failures', () => {
  it('maps every failure code to a DomainError with the contract’s fixed message, never the pipe’s text', async () => {
    for (const code of browserErrorCodeSchema.options) {
      const browser = fakeBrowser(() => {
        const failure = browserFailure('r-1', code)
        return { ...failure, error: { code, message: 'page-authored text C:\\secret' } }
      })
      const error = await failureOf(harness.open('worker', { browserClient: browser }).browserNavigate({ url: 'https://example.com/' }))
      expect(error).toBeInstanceOf(DomainError)
      expect(error.code).toBe(code)
      expect(error.message).toBe(new BrowserControlError(code).message)
    }
  })

  it('refuses a reply whose data does not fit the command', async () => {
    const browser = fakeBrowser(() => ok(STATUS))
    const workspace = harness.open('worker', { browserClient: browser })
    expect((await failureOf(workspace.browserNavigate({ url: 'https://example.com/' }))).code).toBe('internal_error')
    expect((await failureOf(workspace.browserRead({ mode: 'text' }))).code).toBe('internal_error')
    expect((await failureOf(workspace.browserScreenshot({}))).code).toBe('internal_error')
    expect((await failureOf(harness.open('worker', { browserClient: fakeBrowser(() => ok(READ)) }).browserStatus({}))).code).toBe('internal_error')
  })

  it('validates the input before anything is sent', async () => {
    const browser = fakeBrowser(answerFor)
    const workspace = harness.open('worker', { browserClient: browser })
    expect((await failureOf(workspace.browserClick({ ref: 'button' }))).code).toBe('invalid_input')
    expect((await failureOf(workspace.browserPress({ key: 'F5' as 'Enter' }))).code).toBe('invalid_input')
    expect(browser.sent).toEqual([])
  })
})

const made: string[] = []

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A fresh directory the way main writes one, with `bytes` (or nothing) as `shot.png`. */
function shotCopy(bytes: Buffer | null, parent = tmpdir(), prefix = 'dm-browser-shot-'): { directory: string; file: string } {
  const directory = mkdtempSync(join(parent, prefix))
  made.push(directory)
  const file = join(directory, 'shot.png')
  if (bytes !== null) writeFileSync(file, bytes)
  return { directory, file }
}

function screenshotOf(path: string): FakeBrowser {
  return fakeBrowser(() => ok({ image: IMAGE, url: TAB.url, path }))
}

describe('browser_screenshot: staging', () => {
  it('stages the temp PNG as an evidence attachment, answers without the path and removes the copy', async () => {
    const bytes = pngBytes(64, 48)
    const { directory, file } = shotCopy(bytes)
    const browser = screenshotOf(file)

    const view = await harness.open('worker', { browserClient: browser }).browserScreenshot({ as: 'Acolyte:DM-867' })

    expect(browser.sent).toEqual([{ op: 'browser_screenshot', args: { as: 'Acolyte:DM-867' } }])
    expect(view).toMatchObject({
      id: expect.stringMatching(/^im_/), mime: 'image/png', width: 64, height: 48, bytes: bytes.length,
      label: 'Browser screenshot', purpose: 'evidence', createdBy: { role: 'worker' }
    })
    expect(JSON.stringify(view)).not.toContain(directory)
    expect(existsSync(directory)).toBe(false)
    const stored = await harness.open('worker').getAttachment({ attachmentId: view.id, as: 'metadata' })
    expect(stored).toEqual(view)
  })

  it('labels the attachment with the caller’s label', async () => {
    const { file } = shotCopy(pngBytes(10, 10))
    const view = await harness.open('orchestrator', { browserClient: screenshotOf(file) }).browserScreenshot({ label: 'Login page' })
    expect(view).toMatchObject({ label: 'Login page', purpose: 'evidence' })
  })

  it('maps a hidden view to view_hidden and stages nothing', async () => {
    const browser = fakeBrowser(() => browserFailure('r-1', 'view_hidden'))
    const error = await failureOf(harness.open('worker', { browserClient: browser }).browserScreenshot({}))
    expect(error.code).toBe('view_hidden')
    expect(error.message).toBe('The screenshot was refused: browser view not visible.')
  })

  it('removes the copy when staging fails', async () => {
    const { directory, file } = shotCopy(Buffer.from('not an image'))
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(file) }).browserScreenshot({}))
    expect(error.code).toBe('invalid_input')
    expect(existsSync(directory)).toBe(false)
  })
})

describe('browser_screenshot: copies refused and removed', () => {
  it('refuses a copy that is not a regular file, and removes its folder', async () => {
    const { directory, file } = shotCopy(null)
    const target = mkdtempSync(join(tmpdir(), 'dm-browser-target-'))
    made.push(target)
    // A junction on Windows (no privilege needed), a symbolic link elsewhere.
    symlinkSync(target, file, 'junction')
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(file) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('not a regular file') })
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('refuses a missing copy, and removes its folder', async () => {
    const { directory, file } = shotCopy(null)
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(file) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('does not exist') })
    expect(existsSync(directory)).toBe(false)
  })

  it('refuses a copy larger than the attachment limit, and removes its folder', async () => {
    const { directory, file } = shotCopy(pngBytes(10, 10))
    truncateSync(file, MAX_IMAGE_BYTES + 1)
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(file) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('attachment limit') })
    expect(existsSync(directory)).toBe(false)
  })
})

describe('browser_screenshot: copies refused and never removed', () => {
  it('refuses, and never removes, a copy outside the temp folder', async () => {
    const { directory, file } = shotCopy(pngBytes(10, 10), harness.root)
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(file) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('not under the system temp folder') })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(directory)).toBe(true)
  })

  it('refuses, and never removes, a copy in a folder not named for browser screenshots', async () => {
    const { file } = shotCopy(pngBytes(10, 10), tmpdir(), 'dm-other-')
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(file) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('not in a browser screenshot folder') })
    expect(existsSync(file)).toBe(true)
  })

  it('refuses, and never removes, a copy nested deeper than one screenshot folder', async () => {
    const { directory } = shotCopy(null)
    const nested = join(directory, 'dm-browser-shot-inner')
    mkdirSync(nested)
    writeFileSync(join(nested, 'shot.png'), pngBytes(10, 10))
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(join(nested, 'shot.png')) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('not under the system temp folder') })
    expect(existsSync(join(nested, 'shot.png'))).toBe(true)
  })

  it('refuses, and never removes, a screenshot folder that is a link to another folder', async () => {
    const target = mkdtempSync(join(harness.root, 'elsewhere-'))
    writeFileSync(join(target, 'shot.png'), pngBytes(10, 10))
    const link = join(tmpdir(), `dm-browser-shot-link${String(process.pid)}`)
    made.push(link)
    symlinkSync(target, link, 'junction')
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf(join(link, 'shot.png')) }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('link or not a folder') })
    expect(existsSync(join(target, 'shot.png'))).toBe(true)
  })

  it('refuses a relative path', async () => {
    const error = await failureOf(harness.open('worker', { browserClient: screenshotOf('dm-browser-shot-a/shot.png') }).browserScreenshot({}))
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('not an absolute path') })
  })
})

describe('the browser pipe client', () => {
  it('reaches the address in DM_BROWSER_PIPE with the session grant, never the naming pipe', async () => {
    const addresses: string[] = []
    const client = createBrowserClient({
      env: { DM_BROWSER_PIPE: '\\\\.\\pipe\\dm-browser-test', DM_DESKTOP_PIPE: '\\\\.\\pipe\\dm-naming-test', DM_SESSION_TOKEN: 'grant-token' },
      connect: (address) => {
        addresses.push(address)
        throw new Error('no desktop in this test')
      }
    })
    const reply = await client.request({ op: 'browser_status', args: {} })
    expect(addresses).toEqual(['\\\\.\\pipe\\dm-browser-test'])
    expect(reply).toMatchObject({ ok: false, error: { code: 'desktop_unavailable' } })
  })

  it('answers desktop_unavailable without DM_BROWSER_PIPE, even when the naming pipe is set', async () => {
    const addresses: string[] = []
    const client = createBrowserClient({
      env: { DM_DESKTOP_PIPE: '\\\\.\\pipe\\dm-naming-test', DM_SESSION_TOKEN: 'grant-token' },
      connect: (address) => {
        addresses.push(address)
        throw new Error('unreachable')
      }
    })
    expect(await client.request({ op: 'browser_status', args: {} })).toEqual(browserFailure(expect.any(String) as string, 'desktop_unavailable'))
    expect(addresses).toEqual([])
  })
})
