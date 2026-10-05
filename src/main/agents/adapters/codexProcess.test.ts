import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeScratch } from '../../../test/removeScratch'
import { createLineSplitter, planCodexLaunch, spawnCodexTransport } from './codexProcess'

/**
 * These tests start and kill real processes. On Windows a start or a kill occasionally stalls for a long time when
 * the whole suite is running (about 1 full run in 100), so they get a long limit and a retry.
 */
vi.setConfig({ testTimeout: 60_000 })
const REAL_PROCESSES = { retry: 2 }

describe('createLineSplitter', () => {
  function collect(): { lines: string[]; splitter: ReturnType<typeof createLineSplitter> } {
    const lines: string[] = []
    return { lines, splitter: createLineSplitter((line) => lines.push(line)) }
  }

  it('joins a line that arrives in pieces and splits chunks that hold several lines', () => {
    const { lines, splitter } = collect()

    splitter.push('{"a":')
    splitter.push('1}\n{"b":2}\n{"c"')
    splitter.push(':3}\n')

    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('drops the carriage return of a Windows line ending and skips blank lines', () => {
    const { lines, splitter } = collect()

    splitter.push('one\r\n\r\n  \ntwo\r\n')

    expect(lines).toEqual(['one', 'two'])
  })

  it('hands over a last line that has no newline when the stream ends', () => {
    const { lines, splitter } = collect()

    splitter.push('tail')
    expect(lines).toEqual([])
    splitter.flush()
    splitter.flush()

    expect(lines).toEqual(['tail'])
  })
})

const everythingIsAFile = (): 'ok' => 'ok'

describe('planCodexLaunch', () => {
  it('runs the executable directly with the app-server subcommand on macOS and Linux', () => {
    const plan = planCodexLaunch('/usr/local/bin/codex', { platform: 'darwin', inspect: everythingIsAFile })

    expect(plan).toEqual({ launch: { file: '/usr/local/bin/codex', args: ['app-server'], verbatimArguments: false } })
  })

  it('runs a Windows .exe directly', () => {
    const plan = planCodexLaunch('C:\\Tools\\codex.exe', { platform: 'win32', inspect: everythingIsAFile })

    expect(plan).toEqual({ launch: { file: 'C:\\Tools\\codex.exe', args: ['app-server'], verbatimArguments: false } })
  })

  it('runs a Windows .cmd shim through exactly one cmd.exe parse with the path in one pair of quotes', () => {
    const plan = planCodexLaunch('C:\\Users\\a & b\\npm\\codex.cmd', {
      platform: 'win32',
      inspect: everythingIsAFile,
      comspec: 'C:\\Windows\\System32\\cmd.exe'
    })

    expect(plan).toEqual({
      launch: {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/v:off', '/s', '/c', '""C:\\Users\\a & b\\npm\\codex.cmd" app-server"'],
        verbatimArguments: true
      }
    })
  })

  it('refuses a shim path that cmd.exe would expand or end early', () => {
    const plan = planCodexLaunch('C:\\100%\\codex.cmd', { platform: 'win32', inspect: everythingIsAFile })

    expect(plan).toMatchObject({ ok: false, code: 'unsafe_path' })
  })

  it('refuses a path that is not a file', () => {
    const plan = planCodexLaunch('relative/codex', { platform: 'darwin', inspect: everythingIsAFile })

    expect(plan).toMatchObject({ ok: false, code: 'not_a_file' })
  })
})

/** A stand-in for `codex app-server`: answers `whoami`, and `crash` ends it with an exit code and a message on stderr. */
const FAKE_SERVER = `
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'whoami') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) } }) + '\\n')
  }
  if (message.method === 'crash') {
    process.stderr.write('bad things happened\\n')
    process.exit(3)
  }
})
`

let scratch = ''
let fakeCodex = ''
let workFolder = ''

/** The launcher the platform expects: a .cmd shim on Windows, an executable script elsewhere. */
function installFakeCodex(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const server = join(directory, 'server.mjs')
  writeFileSync(server, FAKE_SERVER)
  if (process.platform === 'win32') {
    const shim = join(directory, 'codex.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`)
    return shim
  }
  const script = join(directory, 'codex')
  writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`)
  chmodSync(script, 0o755)
  return script
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dm-codex-')))
  // An ampersand in the path is what would let a second cmd.exe parse run something else.
  fakeCodex = installFakeCodex(join(scratch, 'bin & tools'))
  workFolder = join(scratch, 'work')
  mkdirSync(workFolder)
})

afterAll(() => {
  removeScratch(scratch)
})

function listen(transport: ReturnType<typeof spawnCodexTransport>): { lines: string[]; closes: string[] } {
  const seen = { lines: [] as string[], closes: [] as string[] }
  transport.onLine((line) => seen.lines.push(line))
  transport.onClose((reason) => seen.closes.push(reason))
  return seen
}

describe('spawnCodexTransport', REAL_PROCESSES, () => {
  it('runs the program in the folder with the app-server subcommand and talks JSON lines over stdio', async () => {
    const transport = spawnCodexTransport(fakeCodex, workFolder)
    const seen = listen(transport)

    transport.write(JSON.stringify({ id: 1, method: 'whoami' }))
    await until(() => seen.lines.length > 0)
    await transport.kill()

    const reply = JSON.parse(seen.lines[0] ?? 'null') as { id: number; result: { cwd: string; args: string[] } }
    expect(reply.id).toBe(1)
    expect(reply.result.args).toEqual(['app-server'])
    expect(realpathSync(reply.result.cwd)).toBe(workFolder)
  })

  it('kills the whole process tree, not only the shim that was started', async () => {
    const transport = spawnCodexTransport(fakeCodex, workFolder)
    const seen = listen(transport)
    transport.write(JSON.stringify({ id: 1, method: 'whoami' }))
    await until(() => seen.lines.length > 0)
    const { pid } = (JSON.parse(seen.lines[0] ?? 'null') as { result: { pid: number } }).result
    expect(alive(pid)).toBe(true)

    await transport.kill()
    await until(() => !alive(pid))

    expect(alive(pid)).toBe(false)
    expect(seen.closes).toHaveLength(1)
  })

  it('reports an unexpected exit with its code and what the program said on stderr', async () => {
    const transport = spawnCodexTransport(fakeCodex, workFolder)
    const seen = listen(transport)

    transport.write(JSON.stringify({ id: 1, method: 'crash' }))
    await until(() => seen.closes.length > 0)

    expect(seen.closes).toHaveLength(1)
    expect(seen.closes[0]).toContain('exited with code 3')
    expect(seen.closes[0]).toContain('bad things happened')
  })
})

describe('spawnCodexTransport failures', REAL_PROCESSES, () => {
  it('reports a program that cannot start and a path that cannot be launched safely', async () => {
    expect(() => spawnCodexTransport(join(scratch, 'missing'), workFolder)).toThrow('That is not a file.')
    if (process.platform === 'win32') {
      // A real shim whose folder name holds a percent sign, which cmd.exe would expand even inside quotes.
      const unsafe = installFakeCodex(join(scratch, '100%PATH%'))

      expect(() => spawnCodexTransport(unsafe, workFolder)).toThrow('cannot be launched safely')
    }
  })

  it('ignores writes after the program ended', async () => {
    const transport = spawnCodexTransport(fakeCodex, workFolder)
    const seen = listen(transport)
    await transport.kill()
    await until(() => seen.closes.length > 0)

    expect(() => {
      transport.write(JSON.stringify({ id: 2, method: 'whoami' }))
    }).not.toThrow()
  })
})
