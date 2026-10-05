import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { planShimLaunch } from './shimLaunch'

const COMSPEC = 'C:\\Windows\\System32\\cmd.exe'

/** The command line cmd.exe is given, or a failure that makes the test say so. */
function commandOf(path: string, args: readonly string[], options: { keepOpen?: boolean } = {}): string {
  const plan = planShimLaunch(path, args, { comspec: COMSPEC, ...options })
  if (!plan.ok) {
    throw new Error(`refused: ${plan.reason}`)
  }
  return plan.launch.args[4] as string
}

describe('planShimLaunch: the one parse', () => {
  it('runs cmd.exe once, with the path in one pair of quotes and no shell option', () => {
    const plan = planShimLaunch('C:\\Tools\\codex.cmd', ['app-server'], { comspec: COMSPEC })

    expect(plan).toEqual({
      ok: true,
      launch: { file: COMSPEC, args: ['/d', '/v:off', '/s', '/c', '""C:\\Tools\\codex.cmd" app-server"'], verbatimArguments: true }
    })
  })

  it('finds cmd.exe on the path when no command interpreter is given', () => {
    const plan = planShimLaunch('C:\\Tools\\codex.cmd', ['login'])

    expect(plan).toMatchObject({ ok: true, launch: { file: 'cmd.exe' } })
  })

  it('keeps the window open for a terminal with /k instead of /c', () => {
    const plan = planShimLaunch('C:\\Tools\\claude.exe', ['auth', 'login'], { comspec: COMSPEC, keepOpen: true })

    expect(plan).toEqual({
      ok: true,
      launch: { file: COMSPEC, args: ['/d', '/v:off', '/s', '/k', '""C:\\Tools\\claude.exe" auth login"'], verbatimArguments: true }
    })
  })

  it('never uses start or a nested cmd.exe, and has exactly one command switch', () => {
    const plan = planShimLaunch('C:\\Tools\\codex.cmd', ['app-server'], { comspec: COMSPEC })
    const launch = plan.ok ? plan.launch : null
    const command = launch?.args[4] ?? ''

    expect(launch?.args).toHaveLength(5)
    expect(launch?.args.filter((argument) => /^\/[ck]$/i.test(argument))).toHaveLength(1)
    expect(command.replace('C:\\Tools\\codex.cmd', '')).not.toMatch(/\bstart\b|cmd/i)
    expect(command.startsWith('""')).toBe(true)
    expect(command.endsWith('"')).toBe(true)
  })

  it('has no argument at all when there is nothing to pass', () => {
    expect(commandOf('C:\\Tools\\agent.cmd', [])).toBe('""C:\\Tools\\agent.cmd""')
  })
})

describe('planShimLaunch: a path', () => {
  it.each([
    'C:\\Program Files (x86)\\a & b\\codex.cmd',
    'C:\\x & echo INJECTED & y\\codex.cmd',
    'C:\\a ^ b\\codex.cmd',
    'C:\\a | b > c < d\\codex.cmd',
    'C:\\a!b!\\codex.cmd',
    "C:\\it's here\\codex.cmd"
  ])('keeps %s literal, inside the one pair of quotes', (path) => {
    expect(commandOf(path, ['app-server'])).toBe(`""${path}" app-server"`)
  })

  it.each([
    ['a quote', 'C:\\a"b\\codex.cmd'],
    ['a percent sign', 'C:\\100%PATH%\\codex.cmd'],
    ['a newline', 'C:\\a\nb\\codex.cmd'],
    ['a tab', 'C:\\a\tb\\codex.cmd'],
    ['a NUL', 'C:\\a\0b\\codex.cmd'],
    ['a carriage return', 'C:\\a\rb\\codex.cmd'],
    ['a unit separator', 'C:\\a\u001fb\\codex.cmd'],
    ['a delete character', 'C:\\a\u007fb\\codex.cmd']
  ])('refuses a path with %s, instead of escaping it', (_what, path) => {
    const plan = planShimLaunch(path, ['app-server'], { comspec: COMSPEC })

    expect(plan).toMatchObject({ ok: false, unsafe: 'path', reason: expect.stringMatching(/cannot be launched safely/) })
    expect(plan).not.toHaveProperty('launch')
  })
})

describe('planShimLaunch: arguments', () => {
  it.each(['auth', 'status', '--model', 'gpt-5.3-codex', 'app-server', '--list-models', '.'])(
    'passes the plain argument %s as it is',
    (argument) => {
      expect(commandOf('C:\\Tools\\agent.cmd', [argument])).toBe(`""C:\\Tools\\agent.cmd" ${argument}"`)
    }
  )

  it.each([
    'claude-opus-4-7[thinking=true,effort=high]',
    'gpt-5.4[reasoning=medium,fast=false]',
    'anthropic/claude+x',
    'a & b',
    'a^b',
    '(x)',
    'a|b',
    'a<b>c',
    'a!b',
    'two words',
    ''
  ])('wraps the argument %j in its own pair of quotes so cmd.exe reads it literally', (argument) => {
    expect(commandOf('C:\\Tools\\agent.cmd', ['--model', argument, 'acp'])).toBe(`""C:\\Tools\\agent.cmd" --model "${argument}" acp"`)
  })

  it.each([
    ['a quote', 'x" & calc & "'],
    ['a percent sign', '%PATH%'],
    ['a newline', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a tab', 'a\tb'],
    ['a NUL', 'a\0b'],
    ['a delete character', 'a\u007fb'],
    ['a final backslash, which would escape the closing quote for the program', 'C:\\dir\\']
  ])('refuses an argument with %s, instead of escaping it', (_what, argument) => {
    const plan = planShimLaunch('C:\\Tools\\agent.cmd', ['--model', argument], { comspec: COMSPEC })

    expect(plan).toMatchObject({ ok: false, unsafe: 'argument', reason: expect.stringMatching(/cannot be launched safely/) })
    expect(plan).not.toHaveProperty('launch')
  })

  it('refuses when any one of several arguments is unsafe', () => {
    expect(planShimLaunch('C:\\Tools\\agent.cmd', ['ok', 'fine', 'not"ok'], { comspec: COMSPEC })).toMatchObject({ ok: false })
  })

  it('names the path first when both the path and an argument are unsafe', () => {
    expect(planShimLaunch('C:\\100%\\agent.cmd', ['a"b'], { comspec: COMSPEC })).toMatchObject({ ok: false, unsafe: 'path' })
  })
})

describe.runIf(process.platform === 'win32')('planShimLaunch with a real Windows .cmd shim', () => {
  let scratch = ''

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dm-shim-launch-'))
  })

  afterAll(() => {
    removeScratch(scratch)
  })

  /** A shim that runs Node on a script printing the arguments it received as JSON, in a folder with this name. */
  function makeShim(folder: string): string {
    const dir = join(scratch, folder)
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'show.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    const shim = join(dir, 'agent.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    return shim
  }

  function run(shim: string, args: readonly string[]): { status: number | null; stdout: string } {
    const plan = planShimLaunch(shim, args, { comspec: process.env['ComSpec'] ?? 'cmd.exe' })
    if (!plan.ok) {
      throw new Error(plan.reason)
    }
    const result = spawnSync(plan.launch.file, [...plan.launch.args], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.launch.verbatimArguments
    })
    return { status: result.status, stdout: result.stdout }
  }

  it('keeps a path with an ampersand literal and hands every argument over whole', () => {
    const shim = makeShim('tools & echo INJECTED & more (x86)')
    const model = 'claude-opus-4-7[thinking=true,effort=high]'

    const { status, stdout } = run(shim, ['--model', model, 'two words & more', 'acp'])

    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual(['--model', model, 'two words & more', 'acp'])
    expect(stdout).not.toContain('INJECTED')
  })

  it('does not run a command hidden in a path that has a caret, parentheses and an exclamation mark', () => {
    const shim = makeShim('a ^& b (c) !d!')

    const { status, stdout } = run(shim, ['status'])

    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual(['status'])
  })

  it('starts nothing for a path with a percent sign, which cmd.exe would expand even inside quotes', () => {
    const shim = makeShim('100%COMSPEC%')

    expect(() => run(shim, ['status'])).toThrow(/cannot be launched safely/)
  })
})
