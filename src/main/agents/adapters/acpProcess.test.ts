import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeScratch } from '../../../test/removeScratch'
import type { ProbeLaunch } from '../../desktop/agentProbe'
import { nodeTransport } from './acpProcess'

/**
 * These tests start and kill real processes. On Windows a start or a kill occasionally stalls for a long time when
 * the whole suite is running (about 1 full run in 100), so they get a long limit and a retry.
 */
vi.setConfig({ testTimeout: 60_000 })
const REAL_PROCESSES = { retry: 2 }

/** The real transport is exercised against Node itself, which every machine running these tests has. */
function node(script: string): ProbeLaunch {
  return { file: process.execPath, args: ['-e', script], verbatimArguments: false }
}

interface Heard {
  lines: string[]
  closed: string[]
}

function open(launch: ProbeLaunch, cwd: string): { heard: Heard; handle: ReturnType<typeof nodeTransport> } {
  const heard: Heard = { lines: [], closed: [] }
  const handle = nodeTransport(launch, cwd, {
    line: (text) => heard.lines.push(text),
    closed: (detail) => heard.closed.push(detail)
  })
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

describe('nodeTransport', REAL_PROCESSES, () => {
  it('delivers whole lines however the output is chunked, with the line ending removed', async () => {
    const script = `process.stdout.write('{"a":1}\\n{"b"'); setTimeout(() => process.stdout.write(':2}\\r\\n\\r\\nlast'), 60)`

    const { heard } = open(node(script), scratch)

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })
    expect(heard.lines).toEqual(['{"a":1}', '{"b":2}', 'last'])
  })

  it('writes one line per message to the process and runs it in the folder', async () => {
    const script = `
      console.log(process.cwd())
      process.stdin.setEncoding('utf8').on('data', (text) => { console.log('got:' + text.trim()); process.exit(0) })
    `
    const { heard, handle } = open(node(script), scratch)

    await vi.waitFor(() => expect(heard.lines).toHaveLength(1), { timeout: 30_000 })
    handle.write('{"ping":true}')
    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })

    expect(realpathSync(heard.lines[0] ?? '')).toBe(scratch)
    expect(heard.lines[1]).toBe('got:{"ping":true}')
  })
})

describe('nodeTransport: how the process ended', REAL_PROCESSES, () => {
  it('says how the process ended and the last of what it printed on stderr', async () => {
    const { heard } = open(node(`console.error('boom: no login'); process.exit(3)`), scratch)

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })

    expect(heard.closed[0]).toMatch(/^exit code 3: boom: no login/)
  })

  it('keeps only the tail of a long stderr', async () => {
    const { heard } = open(node(`console.error('x'.repeat(100000) + 'THE-END'); process.exit(1)`), scratch)

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })

    expect(heard.closed[0]?.length).toBeLessThan(1000)
    expect(heard.closed[0]).toContain('THE-END')
  })

  it('reports a program that cannot be started, once', async () => {
    const { heard, handle } = open({ file: join(scratch, 'missing-agent'), args: [], verbatimArguments: false }, scratch)

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })
    handle.write('ignored')
    handle.kill()

    expect(heard.closed[0]).toMatch(/ENOENT/)
    expect(heard.lines).toEqual([])
  })

  it('reports a folder that does not exist as a failed start', async () => {
    const { heard } = open(node('console.log(1)'), join(scratch, 'no-such-folder'))

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })

    expect(heard.closed[0]).toMatch(/ENOENT/)
  })

  it('ignores a write to a process that has already ended', async () => {
    const { heard, handle } = open(node('process.exit(0)'), scratch)

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })

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
    await vi.waitFor(() => expect(heard.lines).toHaveLength(1), { timeout: 30_000 })
    const grandchild = Number((heard.lines[0] ?? '').replace('child:', ''))
    expect(alive(grandchild)).toBe(true)

    handle.kill()

    await vi.waitFor(() => expect(heard.closed).toHaveLength(1), { timeout: 30_000 })
    await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 30_000 })
  })
})
