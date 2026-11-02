/**
 * The settings file main writes before each Claude start (`autoMemoryDirectory` and the memory-folder
 * `PreToolUse` command hook) and, on macOS, the hook's launcher. The launcher is run for real here, through the
 * shells Claude Code runs a hook command with, from a userData and a chat folder whose paths hold spaces, quotes
 * and shell syntax: once with a probe in place of the hook that reports what it was started with, and once with the
 * real hook script (loaded through tsx), which must answer `ask` for a memory-folder write and nothing otherwise.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { removeScratch } from '../../test/removeScratch'
import { MEMORY_HOOK_ASK_OUTPUT, MEMORY_WRITE_TOOLS } from './claudeMemoryGuard'
import { claudeSettings, claudeSettingsPaths, MEMORY_HOOK_SCRIPT, memoryHookLauncherScript, writeClaudeSettings, type ClaudeSettings } from './claudeSettingsFile'
import { shellQuote } from './dmLauncher'
import { windowsCommandLine } from './windowsCommandLine'

/** A path holding everything a careless quoting would break on: spaces, both quotes, `$`, a backtick and `;`. */
const AWKWARD = `it's "Dark" $HOME \`x\`; Mechanicus`

/** A macOS `dm` invocation: its script path is joined the macOS way, whatever system the tests run on. */
function cliFor(command: string, scriptDir: string, folder: string): DarkMechanicusCli {
  return { command, args: [posix.join(scriptDir, 'cli.js'), '--repo', folder], env: { ELECTRON_RUN_AS_NODE: '1', DM_SESSION_TOKEN: 'grant-token' } }
}

describe('claudeSettingsPaths', () => {
  it('puts the settings file under agents/settings, with the macOS hook launcher beside it', () => {
    expect(claudeSettingsPaths('/data', 'ch_1', 'darwin')).toEqual({
      settings: join('/data', 'agents', 'settings', 'ch_1.json'),
      hookLauncher: join('/data', 'agents', 'settings', 'ch_1.memory-hook')
    })
    expect(claudeSettingsPaths('/data', 'ch_1', 'win32')).toEqual({ settings: join('/data', 'agents', 'settings', 'ch_1.json'), hookLauncher: null })
  })

  it('refuses a chat id that could name a path outside that folder', () => {
    for (const id of ['../ch_1', 'a/b', '', '.']) {
      expect(() => claudeSettingsPaths('/data', id, 'darwin')).toThrow(/chat id/)
    }
  })
})

describe('memoryHookLauncherScript', () => {
  it('sets ELECTRON_RUN_AS_NODE for its own process, runs the runtime with every path single-quoted, and asks when that fails', () => {
    const text = memoryHookLauncherScript('/A pp/Dark Mechanicus', '/A pp/out/main/claudeMemoryHook.js', ["/Users/me/it's", '/Users/me', '/var/t $x'])

    expect(text.split('\n')).toEqual([
      '#!/bin/sh',
      '# The Claude Code memory-folder hook for one chat, written by the app at each start.',
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `'/A pp/Dark Mechanicus' '/A pp/out/main/claudeMemoryHook.js' '/Users/me/it'\\''s' '/Users/me' '/var/t $x' || printf '%s\\n' ${shellQuote(MEMORY_HOOK_ASK_OUTPUT)}`,
      ''
    ])
  })

  it.skipIf(process.platform === 'win32').each([
    ['a runtime that is not there', '/nonexistent/runtime'],
    ['a runtime that fails', '/usr/bin/false']
  ])('prints the ask answer when the hook cannot run: %s', (_name, runtime) => {
    const root = mkdtempSync(join(tmpdir(), 'dm-claude-hook-fail-'))
    try {
      const launcher = join(root, 'memory-hook')
      writeFileSync(launcher, memoryHookLauncherScript(runtime, '/nowhere/claudeMemoryHook.js', ['/w', '/h', '/t']), { mode: 0o700 })

      const run = spawnSync('/bin/sh', ['-c', shellQuote(launcher)], { input: '{}', encoding: 'utf8' })

      expect([run.status, JSON.parse(run.stdout)]).toEqual([0, JSON.parse(MEMORY_HOOK_ASK_OUTPUT)])
    } finally {
      removeScratch(root)
    }
  })
})

describe('claudeSettings', () => {
  const OPTIONS = {
    userData: '/Users/me/Library/Application Support/Dark Mechanicus',
    chatId: 'ch_1',
    folder: '/Users/me/My Repo',
    home: '/Users/me',
    tmp: '/var/folders/x/T'
  }

  it('on macOS holds autoMemoryDirectory and a PreToolUse command hook running the single-quoted launcher', () => {
    const cli = cliFor('/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus', '/Applications/Dark Mechanicus.app/Contents/Resources/app.asar/out/main', OPTIONS.folder)
    const launcher = join(OPTIONS.userData, 'agents', 'settings', 'ch_1.memory-hook')

    expect(claudeSettings({ ...OPTIONS, platform: 'darwin', cli })).toEqual({
      autoMemoryDirectory: '/var/folders/x/T/dark-mechanicus-unused-memory',
      hooks: { PreToolUse: [{ matcher: MEMORY_WRITE_TOOLS, hooks: [{ type: 'command', command: `'${launcher}'` }] }] }
    })
  })

  it('on Windows runs the app runtime and the hook script in exec form, which no shell parses, with the folders as arguments', () => {
    const options = {
      userData: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\Dark Mechanicus',
      chatId: 'ch_1',
      folder: 'C:\\Users\\Jane Doe\\My Repo',
      home: 'C:\\Users\\Jane Doe',
      tmp: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp'
    }
    const exe = 'C:\\Program Files\\Dark Mechanicus\\Dark Mechanicus.exe'
    const scripts = 'C:\\Program Files\\Dark Mechanicus\\resources\\app.asar\\out\\main'
    const cli = { command: exe, args: [`${scripts}\\cli.js`, '--repo', options.folder] }

    const settings = claudeSettings({ ...options, platform: 'win32', cli })

    const hook = { type: 'command', command: exe, args: [`${scripts}\\${MEMORY_HOOK_SCRIPT}`, options.folder, options.home, options.tmp] }
    expect(settings).toEqual({
      autoMemoryDirectory: 'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\dark-mechanicus-unused-memory',
      hooks: { PreToolUse: [{ matcher: MEMORY_WRITE_TOOLS, hooks: [hook] }] }
    })
    // The CLI starts it with libuv's quoting, which `windowsCommandLine` reproduces: each spaced path is one argument.
    expect(windowsCommandLine([hook.command, ...hook.args])).toBe(
      '"C:\\Program Files\\Dark Mechanicus\\Dark Mechanicus.exe" "C:\\Program Files\\Dark Mechanicus\\resources\\app.asar\\out\\main\\claudeMemoryHook.js" "C:\\Users\\Jane Doe\\My Repo" "C:\\Users\\Jane Doe" "C:\\Users\\Jane Doe\\AppData\\Local\\Temp"'
    )
  })

  it('refuses a dm invocation that is not pinned to the folder, so the hook never names another', () => {
    const cli = cliFor('/app/runtime', '/app/out/main', '/elsewhere')

    expect(() => claudeSettings({ ...OPTIONS, platform: 'darwin', cli })).toThrow(/--repo/)
  })
})

describe('writeClaudeSettings', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-claude-settings-')))
  })

  afterEach(() => {
    removeScratch(root)
  })

  it('writes the settings file and, on macOS, the hook launcher, and returns the settings path', async () => {
    const userData = join(root, 'userData')
    const folder = join(root, 'repo')
    const cli = cliFor('/app/runtime', '/app/out/main', folder)

    const path = await writeClaudeSettings({ userData, chatId: 'ch_1', platform: 'darwin', folder, cli, home: '/Users/me', tmp: '/tmp' })

    const paths = claudeSettingsPaths(userData, 'ch_1', 'darwin')
    expect(path).toBe(paths.settings)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(claudeSettings({ userData, chatId: 'ch_1', platform: 'darwin', folder, cli, home: '/Users/me', tmp: '/tmp' }))
    expect(readFileSync(paths.hookLauncher as string, 'utf8')).toBe(memoryHookLauncherScript('/app/runtime', `/app/out/main/${MEMORY_HOOK_SCRIPT}`, [folder, '/Users/me', '/tmp']))
  })

  // Windows keeps no POSIX permission bits: it reports any writable file as 0666.
  it.skipIf(process.platform === 'win32')('makes the settings file 0600 and the macOS hook launcher 0700', async () => {
    const userData = join(root, 'userData')
    const folder = join(root, 'repo')

    const path = await writeClaudeSettings({ userData, chatId: 'ch_1', platform: 'darwin', folder, cli: cliFor('/app/runtime', '/app/out/main', folder), home: '/Users/me', tmp: '/tmp' })

    const launcher = claudeSettingsPaths(userData, 'ch_1', 'darwin').hookLauncher as string
    expect([statSync(path).mode & 0o777, statSync(launcher).mode & 0o777]).toEqual([0o600, 0o700])
  })

  it('writes no launcher on Windows', async () => {
    const userData = join(root, 'userData')
    const cli = { command: 'C:\\app\\app.exe', args: ['C:\\app\\out\\main\\cli.js', '--repo', 'C:\\repo'] }

    await writeClaudeSettings({ userData, chatId: 'ch_1', platform: 'win32', folder: 'C:\\repo', cli, home: 'C:\\Users\\me', tmp: 'C:\\t' })

    expect(existsSync(join(userData, 'agents', 'settings', 'ch_1.memory-hook'))).toBe(false)
  })
})

/** A scratch userData, chat folder and `out/main`, each under a path holding spaces, quotes and shell syntax. */
interface HookScratch {
  root: string
  userData: string
  folder: string
  scriptDir: string
}

function hookScratch(): HookScratch {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-claude-hook-')))
  const scratch = { root, userData: join(root, AWKWARD, 'userData'), folder: join(root, AWKWARD, 'my repo'), scriptDir: join(root, AWKWARD, 'out', 'main') }
  mkdirSync(scratch.folder, { recursive: true })
  mkdirSync(scratch.scriptDir, { recursive: true })
  return scratch
}

/** Writes the settings with `runtime` as the app's runtime and runs their hook command the way Claude Code does. */
async function runHook(scratch: HookScratch, runtime: string, shell: string, stdin: string): Promise<string> {
  const { root, userData, folder, scriptDir } = scratch
  const path = await writeClaudeSettings({ userData, chatId: 'ch_1', platform: 'darwin', folder, cli: cliFor(runtime, scriptDir, folder), home: join(root, 'home'), tmp: join(root, AWKWARD, 'tmp') })
  const settings = JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings
  const [hook] = settings.hooks.PreToolUse[0].hooks
  const run = spawnSync(shell, ['-c', hook.command], { input: stdin, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home') } })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return run.stdout
}

describe.skipIf(process.platform === 'win32')('the macOS hook launcher, run from paths holding spaces and quotes', () => {
  let scratch: HookScratch

  beforeEach(() => {
    scratch = hookScratch()
  })

  afterEach(() => {
    removeScratch(scratch.root)
  })

  it.each(['/bin/sh', '/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell)))('reaches the hook with its paths intact and ELECTRON_RUN_AS_NODE set, through %s', async (shell) => {
    const { root, folder, scriptDir } = scratch
    const probe = "let input = ''; process.stdin.on('data', (c) => { input += c }); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, input })) })"
    writeFileSync(join(scriptDir, MEMORY_HOOK_SCRIPT), probe)

    const heard = JSON.parse(await runHook(scratch, process.execPath, shell, '{"hello":1}')) as unknown

    expect(heard).toEqual({ argv: [join(scriptDir, MEMORY_HOOK_SCRIPT), folder, join(root, 'home'), join(root, AWKWARD, 'tmp')], runAsNode: '1', input: '{"hello":1}' })
  })

  it('runs the real hook script, which asks for a memory-folder write and stays silent for any other', async () => {
    const { root, folder, scriptDir } = scratch
    // The hook script loaded from its TypeScript source through tsx, as the built `claudeMemoryHook.js` would run.
    const source = fileURLToPath(new URL('claudeMemoryHook.ts', import.meta.url))
    const tsx = createRequire(import.meta.url).resolve('tsx/cjs/api')
    writeFileSync(join(scriptDir, MEMORY_HOOK_SCRIPT), `require(${JSON.stringify(tsx)}).require(${JSON.stringify(source)}, __filename)\n`)
    const call = (file: string): string => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: folder })

    const asked = await runHook(scratch, process.execPath, '/bin/sh', call(join(root, 'home', '.claude', 'projects', 'p', 'memory', 'MEMORY.md')))
    const pinned = await runHook(scratch, process.execPath, '/bin/sh', call(join(root, AWKWARD, 'tmp', 'dark-mechanicus-unused-memory', 'a.md')))
    const relative = await runHook(scratch, process.execPath, '/bin/sh', call('notes.md'))

    expect(JSON.parse(asked)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })
    expect(JSON.parse(pinned)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
    expect(relative).toBe('')
  })
})
