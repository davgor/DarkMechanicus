import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createEventLog } from '../../../test/eventLog'
import { removeScratch } from '../../../test/removeScratch'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import { nodeTransport } from './acpProcess'

/**
 * These tests start and kill real processes. They wait on what the process does (a line, its close, the end of a
 * tree kill), never on a timer, a poll or a retry, so a slow start or kill only makes a test slower. The long limit
 * is for a Windows start or kill that stalls under load; a hang still fails once it passes.
 */
vi.setConfig({ testTimeout: 60_000 })

/** The real transport is exercised against Node itself, which every machine running these tests has. */
function node(script: string): ProbeLaunch {
  return { file: process.execPath, args: ['-e', script], verbatimArguments: false }
}

interface Heard {
  lines: readonly string[]
  closed: readonly string[]
  /** Resolves once the process has printed `count` lines. */
  linesHeard(count: number): Promise<void>
  /** Resolves once the transport has reported that the process ended. */
  whenClosed(): Promise<void>
}

function open(launch: ProbeLaunch, cwd: string): { heard: Heard; handle: ReturnType<typeof nodeTransport> } {
  const lines = createEventLog<string>()
  const closed = createEventLog<string>()
  const handle = nodeTransport(launch, cwd, {
    line: (text) => {
      lines.push(text)
    },
    closed: (detail) => {
      closed.push(detail)
    }
  })
  const heard: Heard = {
    lines: lines.items,
    closed: closed.items,
    linesHeard: (count) => lines.reached(count),
    whenClosed: () => closed.reached(1)
  }
  return { heard, handle }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let scratch = ''

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dm-acp-')))
})

afterAll(() => {
  removeScratch(scratch)
})

describe('nodeTransport', () => {
  it('delivers whole lines however the output is chunked, with the line ending removed', async () => {
    // The rest is sent only once the first part, which ends inside a line, has been heard: the line is split
    // across two chunks however fast or slow the machine is.
    const script = `
      process.stdout.write('{"a":1}\\n{"b"')
      process.stdin.once('data', () => process.stdout.write(':2}\\r\\n\\r\\nlast', () => process.exit(0)))
    `

    const { heard, handle } = open(node(script), scratch)

    await heard.linesHeard(1)
    handle.write('go')
    await heard.whenClosed()

    expect(heard.lines).toEqual(['{"a":1}', '{"b":2}', 'last'])
  })

  it('writes one line per message to the process and runs it in the folder', async () => {
    const script = `
      console.log(process.cwd())
      process.stdin.setEncoding('utf8').on('data', (text) => { console.log('got:' + text.trim()); process.exit(0) })
    `
    const { heard, handle } = open(node(script), scratch)

    await heard.linesHeard(1)
    handle.write('{"ping":true}')
    await heard.whenClosed()

    expect(realpathSync(heard.lines[0] ?? '')).toBe(scratch)
    expect(heard.lines[1]).toBe('got:{"ping":true}')
  })
})

describe('nodeTransport: how the process ended', () => {
  it('says how the process ended and the last of what it printed on stderr', async () => {
    const { heard } = open(node(`console.error('boom: no login'); process.exit(3)`), scratch)

    await heard.whenClosed()

    expect(heard.closed[0]).toMatch(/^exit code 3: boom: no login/)
  })

  it('keeps only the tail of a long stderr', async () => {
    const { heard } = open(node(`console.error('x'.repeat(100000) + 'THE-END'); process.exit(1)`), scratch)

    await heard.whenClosed()

    expect(heard.closed[0]?.length).toBeLessThan(1000)
    expect(heard.closed[0]).toContain('THE-END')
  })

  it('reports a program that cannot be started, once', async () => {
    const { heard, handle } = open({ file: join(scratch, 'missing-agent'), args: [], verbatimArguments: false }, scratch)

    await heard.whenClosed()
    handle.write('ignored')
    await handle.kill()

    expect(heard.closed).toHaveLength(1)
    expect(heard.closed[0]).toMatch(/ENOENT/)
    expect(heard.lines).toEqual([])
  })

  it('reports a folder that does not exist as a failed start', async () => {
    const { heard } = open(node('console.log(1)'), join(scratch, 'no-such-folder'))

    await heard.whenClosed()

    expect(heard.closed[0]).toMatch(/ENOENT/)
  })

  it('ignores a write to a process that has already ended', async () => {
    const { heard, handle } = open(node('process.exit(0)'), scratch)

    await heard.whenClosed()

    expect(() => {
      handle.write('{"late":true}')
    }).not.toThrow()
  })

  it('kills the whole process tree, not only the process it started', async () => {
    const script = `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log('child:' + child.pid)
      setInterval(() => {}, 1000)
    `
    const { heard, handle } = open(node(script), scratch)
    await heard.linesHeard(1)
    const grandchild = Number((heard.lines[0] ?? '').replace('child:', ''))
    expect(alive(grandchild)).toBe(true)

    await handle.kill()

    // No waiting: kill resolves only once the whole tree has exited.
    expect(alive(grandchild)).toBe(false)
    await heard.whenClosed()
  })
})
