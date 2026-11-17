import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** What the real process saw while `main` ran as the `cli.js` entry point. */
interface EntryRun {
  stdout: string
  stderr: string
  exits: (number | string | null | undefined)[]
}

const savedArgv = process.argv

afterEach(() => {
  process.argv = savedArgv
  vi.restoreAllMocks()
})

/** Loads `main` fresh as though Node had started `out/main/cli.js` with `args`, and waits for its exit. */
async function runAsEntry(args: string[]): Promise<EntryRun> {
  const run: EntryRun = { stdout: '', stderr: '', exits: [] }
  let finished: () => void = () => undefined
  // Promise.withResolvers is outside the TypeScript lib this repo targets.
  const exited = new Promise<void>((resolve) => {
    finished = resolve
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    run.stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    run.stderr += String(chunk)
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    run.exits.push(code)
    finished()
    return undefined as never
  })
  process.argv = [process.execPath, join('/install', 'out', 'main', 'cli.js'), ...args]
  vi.resetModules()
  // The entry check runs at module load, so the module must be loaded again after argv is set.
  await import('./main')
  await exited
  return run
}

describe('dm as the cli.js entry point', () => {
  it('runs with the process arguments and prints to the real stdout', async () => {
    const run = await runAsEntry(['--help'])
    expect(run.stdout).toContain('Usage: dm')
    expect(run.exits).toEqual([0])
  })

  it('writes refusals to the real stderr', async () => {
    const run = await runAsEntry(['--describe', 'frobnicate'])
    expect(run.stderr).toBe('dm: unknown command "frobnicate". Use --list to see them all.\n')
    expect(run.exits).toEqual([2])
  })

  it('reads the token file from disk and opens the named repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-cli-entry-'))
    try {
      const tokenFile = join(dir, 'token')
      writeFileSync(tokenFile, 'dmg_not_a_real_grant\n')
      const run = await runAsEntry(['--repo', join(dir, 'missing-repo'), '--token-file', tokenFile, 'call', 'list_epics'])
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: false })
      expect(run.exits).toEqual([1])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
