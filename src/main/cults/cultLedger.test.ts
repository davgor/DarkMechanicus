/**
 * The cult ledger on the real disk, and the system lookups of leftover member processes with `execFile` faked: the
 * Windows lookups by full System32 path, and what a lookup answers when the program fails or prints nothing.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { createCultLedger, systemLeftovers } from './cultLedger'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

type Answer = { error: Error | null; stdout: string }

/** Every call `execFile` got, and the answer each gets in turn. */
function fakeExec(answers: Answer[]): { file: string; args: readonly string[] }[] {
  const calls: { file: string; args: readonly string[] }[] = []
  vi.mocked(execFile).mockImplementation(((file: string, args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    calls.push({ file, args })
    const answer = answers.shift() ?? { error: null, stdout: '' }
    callback(answer.error, answer.stdout)
  }) as unknown as typeof execFile)
  return calls
}

const GRANT = { runId: 'cr_1', chatId: 'chat_magos', kind: 'allow_save', folder: '/repo', grantId: 'gr_1', tokenFile: null } as const

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'dm-cult-ledger-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(execFile).mockReset()
  removeScratch(userData)
})

describe('cult ledger', () => {
  it('writes nothing for a grant it does not hold, and keeps the ones it does', async () => {
    const ledger = createCultLedger({ userData })
    await ledger.addGrant(GRANT)

    await ledger.removeGrant('gr_unknown')
    expect(ledger.grants()).toEqual([GRANT])
    expect(JSON.parse(readFileSync(join(userData, 'cults', 'ledger.json'), 'utf8')).grants).toEqual([GRANT])
    expect(createCultLedger({ userData }).grants()).toEqual([GRANT])
  })
})

describe('system leftovers on Windows', () => {
  it('looks a command line up through PowerShell under SystemRoot, and ends the tree with taskkill', async () => {
    vi.stubEnv('SystemRoot', 'D:\\Win')
    const calls = fakeExec([{ error: null, stdout: '  omp --session-dir C:\\dm\\chat_magos \r\n' }, { error: null, stdout: 'SUCCESS' }])
    const processes = systemLeftovers('win32')

    expect(await processes.commandLine(4242)).toBe('omp --session-dir C:\\dm\\chat_magos')
    await processes.killTree(4242)
    expect(calls).toEqual([
      {
        file: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=4242").CommandLine']
      },
      { file: 'D:\\Win\\System32\\taskkill.exe', args: ['/pid', '4242', '/t', '/f'] }
    ])
  })

  it('falls back to C:\\Windows without SystemRoot', async () => {
    vi.stubEnv('SystemRoot', undefined)
    const calls = fakeExec([{ error: null, stdout: '' }])

    await systemLeftovers('win32').killTree(7)
    expect(calls[0]!.file).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it.each([
    ['the lookup fails', { error: new Error('Access is denied.'), stdout: 'partial' }],
    ['no process runs as the pid', { error: null, stdout: ' \r\n' }]
  ])('answers no command line when %s', async (_name, answer) => {
    fakeExec([answer])
    expect(await systemLeftovers('win32').commandLine(4242)).toBeNull()
  })
})

describe('system leftovers on this platform', () => {
  it('looks a command line up with ps by default', async () => {
    const calls = fakeExec([{ error: null, stdout: 'omp --session-dir /dm/chat_magos\n' }])
    const processes = process.platform === 'win32' ? systemLeftovers('darwin') : systemLeftovers()

    expect(await processes.commandLine(99)).toBe('omp --session-dir /dm/chat_magos')
    expect(calls).toEqual([{ file: '/bin/ps', args: ['-o', 'command=', '-p', '99'] }])
  })
})
