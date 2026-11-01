/**
 * The per-chat `dm` launcher on macOS: a `/bin/sh` script main writes before each start. The test executes it
 * with a stub runtime, from folders and paths named to break out of any quoting (`$(…)`, a backtick, both quote
 * kinds, a space), and checks that the runtime received exactly the script, `--repo <folder>` and the agent's
 * own arguments, with the Electron switch set for that process alone, and that nothing else ran.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { dmLauncherScript, writeDmLauncher } from './dmLauncher'

const HOSTILE_NAMES = [
  '$(touch pwned-dollar)',
  '`touch pwned-tick`',
  "it's here",
  'say "hi"',
  'two words',
  `all of $(touch pwned-all) \`touch pwned-all2\` 'q' "dq" $HOME ; touch pwned-semi`
]

/** Hostile agent arguments: each must reach the runtime as one argument, unread by the shell. */
const AGENT_ARGS = ['call', 'claim_ticket', '{"note":"$(touch pwned-arg)"}', '`touch pwned-arg2`', "it's", '', '; touch pwned-arg3', '*']

/** Writes the runtime's arguments one per NUL-terminated record, then the switch it saw, to `$DM_TEST_OUT`. */
const STUB_RUNTIME = [
  '#!/bin/sh',
  'for arg in "$@"; do printf \'%s\\0\' "$arg"; done >> "$DM_TEST_OUT"',
  'printf \'ELECTRON_RUN_AS_NODE=%s\\0\' "${ELECTRON_RUN_AS_NODE-unset}" >> "$DM_TEST_OUT"',
  ''
].join('\n')

describe.skipIf(process.platform === 'win32')('the macOS dm launcher, executed', () => {
  let scratch: string
  let runtime: string
  let script: string

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dm-launcher-'))
    const tools = join(scratch, "tools $(touch pwned-tools) `touch pwned-tools2` 'q' \"dq\"")
    mkdirSync(tools)
    runtime = join(tools, 'Dark Mechanicus')
    writeFileSync(runtime, STUB_RUNTIME)
    chmodSync(runtime, 0o700)
    script = join(tools, "cli 'x'.js")
  })

  afterAll(() => {
    removeScratch(scratch)
  })

  it.each(HOSTILE_NAMES)('runs the runtime with exactly the agent arguments and --repo %s, and nothing else', async (name) => {
    const folder = join(scratch, 'repos', name)
    mkdirSync(folder, { recursive: true })
    const binDir = join(scratch, 'bin', name)
    const out = join(scratch, `out-${HOSTILE_NAMES.indexOf(name)}`)
    const launcher = await writeDmLauncher(binDir, dmLauncherScript({ command: runtime, args: [script, '--repo', folder] }, folder))

    const run = spawnSync(launcher, AGENT_ARGS, { cwd: scratch, env: { PATH: '/usr/bin:/bin', DM_TEST_OUT: out }, encoding: 'utf8' })

    expect(run.status, run.stderr).toBe(0)
    const records = readFileSync(out, 'utf8').split('\0').slice(0, -1)
    expect(records).toEqual([script, '--repo', folder, ...AGENT_ARGS, 'ELECTRON_RUN_AS_NODE=1'])
    // A `touch pwned-…` anywhere in the scratch tree would leave such a file; the hostile names hold the word but never start with it.
    expect(readdirSync(scratch, { recursive: true, encoding: 'utf8' }).filter((entry) => basename(entry).startsWith('pwned'))).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('the macOS dm launcher file', () => {
  let scratch: string

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dm-launcher-file-'))
  })

  afterAll(() => {
    removeScratch(scratch)
  })

  it('is a mode 0700 /bin/sh script in its own 0700 folder that ends by exec-ing the runtime with "$@"', async () => {
    const folder = join(scratch, 'plain')
    const binDir = join(scratch, 'bin', 'plain')
    const text = dmLauncherScript({ command: '/Apps/D M.app/rt', args: ["/Apps/it's/cli.js", '--repo', folder] }, folder)
    const launcher = await writeDmLauncher(binDir, text)

    expect(launcher).toBe(join(binDir, 'dm'))
    expect(statSync(launcher).mode & 0o777).toBe(0o700)
    expect(statSync(binDir).mode & 0o777).toBe(0o700)
    expect(text.split('\n')[0]).toBe('#!/bin/sh')
    expect(text).toContain("ELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\n")
    expect(text.trimEnd().split('\n').at(-1)).toBe(`exec '/Apps/D M.app/rt' '/Apps/it'\\''s/cli.js' --repo '${folder}' "$@"`)
  })

  it('rewrites the launcher at each start and keeps it 0700 even when the old file was opened up', async () => {
    const folder = join(scratch, 'again')
    const binDir = join(scratch, 'bin', 'again')
    const launcher = await writeDmLauncher(binDir, dmLauncherScript({ command: '/old/rt', args: ['/old/cli.js', '--repo', folder] }, folder))
    chmodSync(launcher, 0o777)

    await writeDmLauncher(binDir, dmLauncherScript({ command: '/new/rt', args: ['/new/cli.js', '--repo', folder] }, folder))

    expect(readFileSync(launcher, 'utf8')).toContain("exec '/new/rt' '/new/cli.js'")
    expect(statSync(launcher).mode & 0o777).toBe(0o700)
  })
})

describe('dmLauncherScript: pinned to the chat folder', () => {
  it('refuses a dm invocation that is not pinned to the chat folder', () => {
    const folder = '/Users/me/mine'

    expect(() => dmLauncherScript({ command: '/rt', args: ['/cli.js', '--repo', '/elsewhere'] }, folder)).toThrow(/--repo/)
    expect(() => dmLauncherScript({ command: '/rt', args: ['/cli.js', '--repo', folder, '--extra'] }, folder)).toThrow(/--repo/)
    expect(() => dmLauncherScript({ command: '/rt', args: ['/cli.js', '--project', folder] }, folder)).toThrow(/--repo/)
  })
})
