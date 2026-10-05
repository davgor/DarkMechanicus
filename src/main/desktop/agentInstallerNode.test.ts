import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import type { InstallLaunch } from './agentInstallRecipes'
import {
  createInstallerFiles,
  createInstallerHttp,
  nodeInstallEnvironment,
  runInstallerProcess
} from './agentInstallerNode'

/** None of these tests reaches a network: every request goes to a fake fetch that serves canned bytes. */
type FetchCall = { url: string; init: RequestInit | undefined }

interface Reply {
  chunks?: string[]
  status?: number
  headers?: Record<string, string>
  /** The final URL after redirects, as `Response.url` reports it. */
  url?: string
}

function fakeFetch(reply: Reply): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init })
      const encoder = new TextEncoder()
      const chunks = reply.chunks ?? []
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        }
      })
      const response = new Response(body, { status: reply.status ?? 200, headers: reply.headers ?? {} })
      Object.defineProperty(response, 'url', { value: reply.url ?? url })
      return Promise.resolve(response)
    }
  }
}

let scratch = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dm-installer-'))
})

afterAll(() => {
  removeScratch(scratch)
})

describe('download', () => {
  it('writes the body to the destination and returns its SHA-256', async () => {
    const { fetch, calls } = fakeFetch({ chunks: ['hello ', 'world'] })
    const destination = join(scratch, 'script-a.ps1')

    const result = await createInstallerHttp(fetch).download('https://claude.ai/install.ps1', destination, () => undefined)

    expect(readFileSync(destination, 'utf8')).toBe('hello world')
    expect(result).toEqual({ sha256: createHash('sha256').update('hello world').digest('hex') })
    expect(calls.map((call) => call.url)).toEqual(['https://claude.ai/install.ps1'])
  })

  it('reports whole percentages from the content length, and null when the size is unknown', async () => {
    const known: (number | null)[] = []
    const unknown: (number | null)[] = []

    await createInstallerHttp(fakeFetch({ chunks: ['aaaa', 'bbbb'], headers: { 'content-length': '8' } }).fetch).download(
      'https://claude.ai/install.sh',
      join(scratch, 'script-b.sh'),
      (percent) => known.push(percent)
    )
    await createInstallerHttp(fakeFetch({ chunks: ['aaaa'] }).fetch).download(
      'https://claude.ai/install.sh',
      join(scratch, 'script-c.sh'),
      (percent) => unknown.push(percent)
    )

    expect(known).toEqual([50, 100])
    expect(unknown).toEqual([null])
  })

  it('never reports more than 100 percent when the body outgrows its content length', async () => {
    const seen: (number | null)[] = []
    const { fetch } = fakeFetch({ chunks: ['abcd'], headers: { 'content-length': '2' } })

    await createInstallerHttp(fetch).download('https://claude.ai/install.sh', join(scratch, 'script-e.sh'), (percent) => seen.push(percent))

    expect(seen).toEqual([100])
  })

  it('does not overwrite a file that is already there', async () => {
    const destination = join(scratch, 'script-d.sh')
    const http = createInstallerHttp(fakeFetch({ chunks: ['x'] }).fetch)
    await http.download('https://claude.ai/install.sh', destination, () => undefined)

    await expect(http.download('https://claude.ai/install.sh', destination, () => undefined)).rejects.toThrow(/EEXIST/)
  })
})

describe('download refusals', () => {
  it('never requests an address that is not HTTPS', async () => {
    const { fetch, calls } = fakeFetch({ chunks: ['x'] })
    const http = createInstallerHttp(fetch)

    await expect(http.download('http://claude.ai/install.sh', join(scratch, 'e.sh'), () => undefined)).rejects.toThrow(/HTTPS/)
    await expect(http.getJson('http://api.github.com/x')).rejects.toThrow(/HTTPS/)

    expect(calls).toEqual([])
  })

  it('refuses a redirect that lands on a non-HTTPS address', async () => {
    const { fetch } = fakeFetch({ chunks: ['x'], url: 'http://mirror.example/install.sh' })

    await expect(
      createInstallerHttp(fetch).download('https://claude.ai/install.sh', join(scratch, 'f.sh'), () => undefined)
    ).rejects.toThrow(/non-HTTPS/)
  })

  it('reports an error status', async () => {
    const { fetch } = fakeFetch({ status: 404 })

    await expect(
      createInstallerHttp(fetch).download('https://claude.ai/install.sh', join(scratch, 'g.sh'), () => undefined)
    ).rejects.toThrow(/HTTP 404/)
  })

  it('stops a body larger than the cap', async () => {
    const { fetch } = fakeFetch({ chunks: ['123456', '789012'] })
    const http = createInstallerHttp(fetch, { maxBytes: 8 })

    await expect(http.download('https://claude.ai/install.sh', join(scratch, 'h.sh'), () => undefined)).rejects.toThrow(/larger than/)
  })

  it('gives every request a timeout', async () => {
    const { fetch, calls } = fakeFetch({ chunks: ['{}'] })

    await createInstallerHttp(fetch).getJson('https://api.github.com/repos/openai/codex/releases/latest')

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.init?.redirect).toBe('follow')
  })
})

describe('getJson', () => {
  it('parses a JSON body and identifies the app to the API', async () => {
    const { fetch, calls } = fakeFetch({ chunks: ['{"tag_name":', '"v1"}'] })

    expect(await createInstallerHttp(fetch).getJson('https://api.github.com/x')).toEqual({ tag_name: 'v1' })

    expect(calls[0]?.init?.headers).toMatchObject({ Accept: 'application/json', 'User-Agent': 'DarkMechanicus' })
  })

  it('rejects an error status', async () => {
    const { fetch } = fakeFetch({ status: 403 })

    await expect(createInstallerHttp(fetch).getJson('https://api.github.com/x')).rejects.toThrow(/HTTP 403/)
  })
})

function node(script: string, env: Record<string, string> = {}): InstallLaunch {
  return { file: process.execPath, args: ['-e', script], env }
}

describe('runInstallerProcess', () => {
  it('reports the exit code with stdout and stderr together', async () => {
    const outcome = await runInstallerProcess(node("console.log('to-out'); console.error('to-err'); process.exit(3)"), 10_000)

    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 3 })
    expect(outcome.kind === 'exited' && outcome.output).toContain('to-out')
    expect(outcome.kind === 'exited' && outcome.output).toContain('to-err')
  })

  it('adds the recipe variables to the environment and closes stdin', async () => {
    const script = "process.stdin.on('end', () => console.log('eof ' + process.env.DM_RECIPE)); process.stdin.resume()"

    const outcome = await runInstallerProcess(node(script, { DM_RECIPE: 'yes' }), 10_000)

    expect(outcome.kind === 'exited' && outcome.output).toContain('eof yes')
  })

  it('keeps the end of long output, not the start', async () => {
    const outcome = await runInstallerProcess(node("console.log('x'.repeat(100000)); console.log('LAST LINE')"), 10_000)

    expect(outcome.kind === 'exited' && outcome.output.trimEnd().endsWith('LAST LINE')).toBe(true)
    expect(outcome.kind === 'exited' && outcome.output.length).toBeLessThan(20_000)
  })

  it('stops an installer that runs past the timeout and keeps what it said', async () => {
    const outcome = await runInstallerProcess(node("console.log('still working'); setInterval(() => {}, 1000)"), 1_500)

    expect(outcome.kind).toBe('timed_out')
    expect(outcome.kind === 'timed_out' && outcome.output).toContain('still working')
  })

  it('passes an argument full of shell characters through as one literal argument', async () => {
    const hostile = 'C:\\Users\\A&B 100% ^x (y) !z'

    const outcome = await runInstallerProcess(
      { file: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', hostile], env: {} },
      10_000
    )

    expect(outcome.kind === 'exited' && JSON.parse(outcome.output.trim())).toEqual([hostile])
  })

  it('reports a program that cannot be started with its error code', async () => {
    const outcome = await runInstallerProcess({ file: join(scratch, 'missing'), args: [], env: {} }, 10_000)

    expect(outcome).toMatchObject({ kind: 'spawn_failed', code: 'ENOENT' })
  })
})

describe('createInstallerFiles', () => {
  it('makes a fresh folder under the given root and removes it with its contents', () => {
    const files = createInstallerFiles(scratch)

    const first = files.makeTempDir()
    const second = files.makeTempDir()
    expect(first).not.toBe(second)
    expect(first.startsWith(scratch)).toBe(true)
    expect(existsSync(first)).toBe(true)

    files.removeDir(first)
    files.removeDir(first)

    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(true)
  })
})

describe('nodeInstallEnvironment', () => {
  it('reads the home folder, LOCALAPPDATA and SystemRoot', () => {
    expect(
      nodeInstallEnvironment({
        platform: 'win32',
        arch: 'arm64',
        homeDir: 'C:\\Users\\Ada',
        env: { LOCALAPPDATA: 'D:\\Local', SystemRoot: 'D:\\Win' }
      })
    ).toEqual({ platform: 'win32', arch: 'arm64', homeDir: 'C:\\Users\\Ada', localAppData: 'D:\\Local', systemRoot: 'D:\\Win' })
  })

  it('falls back to the usual Windows folders and to this process', () => {
    const environment = nodeInstallEnvironment({ homeDir: join('home', 'ada'), env: {} })

    expect(environment.localAppData).toBe(join('home', 'ada', 'AppData', 'Local'))
    expect(environment.systemRoot).toBe('C:\\Windows')
    expect(environment.platform).toBe(process.platform)
    expect(environment.arch).toBe(process.arch)
  })
})
