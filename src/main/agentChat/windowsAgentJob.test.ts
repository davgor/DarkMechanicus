import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { windowsAgentJob } from './windowsAgentJob'

const CLI = resolve('src/main/agentChat/__fixtures__/fakeAgentCli.mjs')
let scratch: string
const children: { child: ChildProcessWithoutNullStreams; closed: Promise<number | null> }[] = []
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'dm-job-frame-')) })
afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
  removeScratch(scratch)
})

function launch(frame: Buffer, shortReads = false) {
  const job = windowsAgentJob(process.execPath, [CLI])
  const args = [...job.args]
  if (shortReads) {
    const index = args.indexOf('-EncodedCommand') + 1
    const script = Buffer.from(args[index], 'base64').toString('utf16le')
    expect(script).toContain('(uint)(length - offset)')
    // Force the production accumulation loop through real native reads of at most three bytes.
    args[index] = Buffer.from(script.replace('(uint)(length - offset)', '(uint)Math.Min(3, length - offset)'), 'utf16le').toString('base64')
  }
  const child = spawn(job.file, args, { cwd: scratch, env: { ...process.env, FAKE_AGENT_LOG: join(scratch, 'fake.jsonl') }, stdio: 'pipe', windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
  child.stdin.on('error', () => { /* Malformed-frame rejection may close stdin before the writer finishes. */ })
  const closed = new Promise<number | null>((resolveClose, reject) => {
    child.once('error', reject)
    child.once('close', resolveClose)
  })
  children.push({ child, closed })
  child.stdin.end(frame)
  return { child, closed, output: () => ({ stdout, stderr }) }
}

it('keeps the supervisor command fixed and below the Windows limit for full-size launch data', () => {
  const small = windowsAgentJob(process.execPath, [])
  const room = 32766 - (process.execPath.length + 5)
  const large = windowsAgentJob(process.execPath, ['猫'.repeat(room)])
  expect(large.args).toEqual(small.args)
  expect([large.file, ...large.args].join(' ').length).toBeLessThan(32767)
  const fileLength = large.stdin.readUInt32LE(4)
  const command = large.stdin.subarray(12 + fileLength).toString('utf8')
  expect(command.length).toBe(32766)
  expect(large.stdin.readUInt32LE(8)).toBe(Buffer.byteLength(command))
  expect(() => windowsAgentJob(process.execPath, ['a'.repeat(room + 1)])).toThrow('CreateProcess limit')
  expect(() => windowsAgentJob('bad\0file', [])).toThrow('contains NUL')
})

describe.runIf(process.platform === 'win32')('native exact-read launch framing', () => {
  it.each([false, true])('preserves immediate JSONL and EOF without prefetch (forced short reads: %s)', async (shortReads) => {
    const job = windowsAgentJob(process.execPath, [CLI])
    const jsonl = '{"type":"prompt","message":"immediate 猫"}\n'
    const harness = launch(Buffer.concat([job.stdin, Buffer.from(jsonl)]), shortReads)
    expect(await harness.closed).toBe(0)
    expect(harness.output()).toEqual({ stdout: `fake-tui ready session_T1\n${jsonl}`, stderr: '' })
    const record = JSON.parse(readFileSync(join(scratch, 'fake.jsonl'), 'utf8')) as { pid: number }
    expect(() => process.kill(harness.child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
    expect(() => process.kill(record.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  })

  const badFrames: [string, (frame: Buffer) => Buffer][] = [
    ['truncated header', (frame) => frame.subarray(0, 5)],
    ['bad magic', (frame) => { frame[0] = 0; return frame }],
    ['zero length', (frame) => { frame.writeUInt32LE(0, 4); return frame }],
    ['oversized length', (frame) => { frame.writeUInt32LE(32766 * 3 + 1, 8); return frame.subarray(0, 12) }],
    ['truncated payload', (frame) => frame.subarray(0, -1)],
    ['invalid UTF8', (frame) => { frame[12] = 255; return frame }],
    ['embedded NUL', (frame) => { frame[12] = 0; return frame }]
  ]
  it.each(badFrames)('rejects %s before starting the CLI', async (_name, corrupt) => {
    const harness = launch(corrupt(windowsAgentJob(process.execPath, [CLI]).stdin))
    expect(await harness.closed).toBe(1)
    expect(harness.output().stdout).toBe('')
    expect(harness.output().stderr).toContain('Windows agent job failed:')
    expect(existsSync(join(scratch, 'fake.jsonl'))).toBe(false)
    expect(() => process.kill(harness.child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  })
})
