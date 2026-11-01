import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../../core/db/database'
import { migrate } from '../../core/db/migrations'
import { DomainError } from '../../core/errors'
import type { AgentFindResult } from '../../shared/desktop/api'
import type { FileCheck } from './agentProbe'
import { removeScratch } from '../../test/removeScratch'
import { createAgentRegistry, type AgentRegistry } from './agentRegistry'
import { inspectExecutable } from './agentProbeNode'
import { APP_MIGRATIONS } from './appDatabase'
import {
  createCustomAgents,
  customAgentApproved,
  customAgentDialogOptions,
  customExecutableDialogOptions,
  type CustomAgentConfirmation,
  type CustomAgents
} from './customAgent'
import { createFolderAgentDefaults } from './folderAgentDefaults'

const STAMP = '2026-01-01T00:00:00.000Z'
const PROGRAM = '/opt/tools/my-agent'
const CUSTOM_ID = /^cu_[0-9a-hjkmnp-tv-z]{26}$/

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  // Promise.withResolvers is outside the TypeScript lib this repo targets.
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface WorldOptions {
  /** Successive results of the native file dialog (null is a cancelled dialog); a promise holds the dialog open. */
  picks?: (string | null | Promise<string | null>)[]
  /** Successive answers to the confirmation; defaults to yes. */
  answers?: (boolean | Promise<boolean>)[]
  platform?: string
  inspect?: (path: string) => FileCheck
}

interface World {
  db: Db
  registry: AgentRegistry
  custom: CustomAgents
  /** What happened, in order: `pick`, `confirm`. */
  log: string[]
  confirmations: CustomAgentConfirmation[]
}

function createWorld(options: WorldOptions = {}): World {
  const db = openDatabase(':memory:')
  migrate(db, APP_MIGRATIONS)
  const registry = createAgentRegistry({ db, now: () => STAMP })
  const picks = [...(options.picks ?? [PROGRAM])]
  const answers = [...(options.answers ?? [])]
  const world: World = { db, registry, custom: undefined as never, log: [], confirmations: [] }
  world.custom = createCustomAgents({
    agents: registry,
    pickExecutable: async () => {
      world.log.push('pick')
      return (await picks.shift()) ?? null
    },
    confirm: async (confirmation) => {
      world.log.push('confirm')
      world.confirmations.push(confirmation)
      return (await answers.shift()) ?? true
    },
    launch: { platform: options.platform ?? 'linux', inspect: options.inspect ?? (() => 'ok') }
  })
  return world
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    return error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'unexpected', message: String(error) }
  }
  return { code: 'resolved', message: '' }
}

function addRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'My agent', args: ['--acp', '{folder}'], ...overrides }
}

function connected(result: AgentFindResult): Extract<AgentFindResult, { outcome: 'connected' }>['agent'] {
  if (result.outcome !== 'connected') {
    throw new Error(`expected connected, got ${JSON.stringify(result)}`)
  }
  return result.agent
}

async function expectRefusedBeforeAnything(world: World, payload: unknown): Promise<void> {
  expect((await rejectionOf(world.custom.add(payload))).code).toBe('invalid_input')
  expect(world.log).toEqual([])
  expect(world.registry.list()).toEqual([])
}

describe('adding a custom CLI stores it only after the pick and the confirmation', () => {
  it('stores a cu_ row with its args and no protocol, connected as custom, without running anything to check it', async () => {
    const world = createWorld()

    const agent = connected(await world.custom.add(addRequest()))

    // Nothing is run: no handshake, version command or other probe; the CLI first runs in a chat's terminal.
    expect(world.log).toEqual(['pick', 'confirm'])
    expect(agent).toEqual({
      id: expect.stringMatching(CUSTOM_ID),
      kind: 'custom',
      displayName: 'My agent',
      executablePath: PROGRAM,
      args: ['--acp', '{folder}'],
      version: null,
      needsReview: false,
      connectedVia: 'custom',
      connectedAt: STAMP,
      lastProbed: STAMP
    })
    expect(
      world.db.get('SELECT * FROM agents WHERE id = ?', agent.id)
    ).toEqual({
      id: agent.id,
      kind: 'custom',
      display_name: 'My agent',
      executable_path: PROGRAM,
      connected_via: 'custom',
      args_json: '["--acp","{folder}"]',
      version: null,
      needs_review: 0,
      connected_at: STAMP,
      last_probed: STAMP
    })
  })

  it('confirms exactly the name, the picked program and the typed arguments, and stores them', async () => {
    const world = createWorld()

    await world.custom.add(addRequest({ args: ['--model', 'haiku'] }))

    expect(world.confirmations).toEqual([{ action: 'add', name: 'My agent', executablePath: PROGRAM, args: ['--model', 'haiku'] }])
    expect(world.registry.list()).toEqual([expect.objectContaining({ executablePath: PROGRAM, args: ['--model', 'haiku'] })])
  })

  it('gives each agent its own id', async () => {
    const world = createWorld({ picks: [PROGRAM, PROGRAM] })

    const first = connected(await world.custom.add(addRequest({ args: [] })))
    const second = connected(await world.custom.add(addRequest({ name: 'Other agent' })))

    expect(first).toMatchObject({ version: null, needsReview: false })
    expect(first.id).not.toBe(second.id)
    expect(world.registry.list().map((agent) => agent.displayName)).toEqual(['My agent', 'Other agent'])
  })
})

describe('adding a custom CLI stores nothing when the person backs out', () => {
  it('stores nothing and asks nothing more when the file dialog is cancelled', async () => {
    const world = createWorld({ picks: [null] })

    expect(await world.custom.add(addRequest())).toEqual({ outcome: 'cancelled' })
    expect(world.log).toEqual(['pick'])
    expect(world.registry.list()).toEqual([])
  })

  it('runs nothing and stores nothing when the confirmation is declined', async () => {
    const world = createWorld({ answers: [false] })

    expect(await world.custom.add(addRequest())).toEqual({ outcome: 'cancelled' })
    expect(world.log).toEqual(['pick', 'confirm'])
    expect(world.registry.list()).toEqual([])
  })
})

describe('custom CLI names', () => {
  it('accepts 64 characters and refuses 65, before any dialog', async () => {
    const world = createWorld()
    expect(connected(await world.custom.add(addRequest({ name: 'a'.repeat(64) }))).displayName).toBe('a'.repeat(64))

    const refused = createWorld()
    await expectRefusedBeforeAnything(refused, addRequest({ name: 'a'.repeat(65) }))
    // U+0958 becomes two code units under NFC: the limit applies to what is stored.
    await expectRefusedBeforeAnything(createWorld(), addRequest({ name: '\u0958'.repeat(64) }))
  })

  it('trims the name, and refuses one that is empty once trimmed', async () => {
    const world = createWorld()
    expect(connected(await world.custom.add(addRequest({ name: '  Spaced  ' }))).displayName).toBe('Spaced')

    await expectRefusedBeforeAnything(createWorld(), addRequest({ name: '' }))
    await expectRefusedBeforeAnything(createWorld(), addRequest({ name: '   ' }))
  })

  it.each([
    ['a bell', 'Bad\u0007name'],
    ['a newline', 'Two\nlines'],
    ['a tab', 'Tab\there'],
    ['a right-to-left override', 'evil\u202Eexe.txt'],
    ['a bidi isolate', 'name\u2066x\u2069'],
    ['a zero-width space', 'zero\u200Bwidth'],
    ['a right-to-left mark', 'mark\u200Fed'],
    ['a line separator', 'line\u2028separated'],
    ['a lone surrogate', 'lone\uD800surrogate'],
    ['a combining grapheme joiner', 'My\u034F agent'],
    ['a Hangul filler', 'My\u3164agent'],
    ['a variation selector', 'My\uFE0F agent'],
    ['a no-break space', 'My\u00A0agent'],
    ['an ideographic space', 'My\u3000agent'],
    ['an em space', 'My\u2003agent']
  ])('refuses a name with %s', async (_label, name) => {
    await expectRefusedBeforeAnything(createWorld(), addRequest({ name }))
  })

  it('refuses a name another custom CLI has, whatever its case, before any dialog', async () => {
    const world = createWorld({ picks: [PROGRAM, PROGRAM] })
    await world.custom.add(addRequest({ name: 'My Agent' }))
    world.log.length = 0

    expect(await rejectionOf(world.custom.add(addRequest({ name: 'my agent' })))).toEqual({
      code: 'conflict',
      message: expect.stringContaining('my agent')
    })
    expect(world.log).toEqual([])
    expect(world.registry.list()).toHaveLength(1)
  })
})

describe('custom CLI arguments', () => {
  it('accepts 32 arguments and refuses 33', async () => {
    const args = Array.from({ length: 32 }, (_, index) => `--a${index}`)
    expect(connected(await createWorld().custom.add(addRequest({ args }))).args).toEqual(args)

    await expectRefusedBeforeAnything(createWorld(), addRequest({ args: [...args, '--one-more'] }))
  })

  it('accepts an argument of 1024 characters and refuses one of 1025, or an empty one', async () => {
    const long = 'x'.repeat(1024)
    expect(connected(await createWorld().custom.add(addRequest({ args: [long] }))).args).toEqual([long])

    await expectRefusedBeforeAnything(createWorld(), addRequest({ args: [`${long}x`] }))
    await expectRefusedBeforeAnything(createWorld(), addRequest({ args: [''] }))
  })

  it.each([
    ['a NUL', 'a\u0000b'],
    ['an escape', '\u001b[31mred'],
    ['a newline', '--x\n--y'],
    ['a delete', 'del\u007f'],
    ['a right-to-left override', '--out=\u202Etxt.exe'],
    ['a zero-width joiner', '{fold\u200Der}'],
    ['a no-break space', '--model\u00A0opus'],
    ['an ideographic space', 'x\u3000y'],
    ['an em space', 'x\u2003y']
  ])('refuses an argument with %s', async (_label, arg) => {
    await expectRefusedBeforeAnything(createWorld(), addRequest({ args: ['--ok', arg] }))
  })

  it.each(['--dir={folder}', '{folder}/sub', '{{folder}}', 'x{folder}'])('refuses %j: {folder} must be a whole argument', async (arg) => {
    await expectRefusedBeforeAnything(createWorld(), addRequest({ args: [arg] }))
  })

  it('accepts {folder} as whole arguments, more than once, and keeps it for each start to replace', async () => {
    const world = createWorld()

    const agent = connected(await world.custom.add(addRequest({ args: ['{folder}', '--cwd', '{folder}'] })))

    expect(agent.args).toEqual(['{folder}', '--cwd', '{folder}'])
  })

  it('refuses arguments that are not a list of strings', async () => {
    for (const args of ['--acp', [42], [null], { 0: '--acp' }, undefined]) {
      const world = createWorld()
      expect((await rejectionOf(world.custom.add(addRequest({ args })))).code).toBe('invalid_input')
      expect(world.log).toEqual([])
      expect(world.registry.list()).toEqual([])
    }
  })
})

describe('custom CLI payloads never carry a path', () => {
  it.each([
    ['an executablePath', addRequest({ executablePath: '/bin/sh' })],
    ['a path', addRequest({ path: '/bin/sh' })],
    ['a command', addRequest({ command: 'rm -rf /' })],
    ['an id', addRequest({ id: 'cu_01m61r9qvzjh2yyk89xbzd67dn' })],
    ['a __proto__ key', JSON.parse('{"name":"x","args":[],"__proto__":{"executablePath":"/bin/sh"}}') as unknown],
    ['a constructor key', addRequest({ constructor: { executablePath: '/bin/sh' } })],
    ['a protocol, which a custom CLI no longer has', addRequest({ protocol: 'acp' })],
    ['a version or agent name, which only a handshake gave', addRequest({ version: '1.0.0', reportedName: 'x' })],
    ['a review mark', addRequest({ needsReview: false })],
    ['no name', { args: [] }],
    ['no arguments', { name: 'x' }],
    ['a string', '/bin/sh'],
    ['a list', [addRequest()]],
    ['null', null],
    ['nothing', undefined]
  ])('refuses a payload with %s before any dialog', async (_label, payload) => {
    await expectRefusedBeforeAnything(createWorld(), payload)
  })
})

describe('the picked program and argv must pass the launch rules for this platform', () => {
  it('refuses a pick that is not executable, before the confirmation', async () => {
    const world = createWorld({ inspect: () => 'not_executable' })

    expect(await world.custom.add(addRequest())).toEqual({ outcome: 'refused', code: 'not_executable', reason: expect.any(String) })
    expect(world.log).toEqual(['pick'])
    expect(world.registry.list()).toEqual([])
  })

  it('refuses a Windows pick that is not a program, and a shim argument cmd.exe cannot be given safely', async () => {
    const script = createWorld({ platform: 'win32', picks: ['C:\\tools\\agent.ps1'] })
    expect(await script.custom.add(addRequest())).toMatchObject({ outcome: 'refused', code: 'not_executable' })

    const shim = createWorld({ platform: 'win32', picks: ['C:\\tools\\agent.cmd'] })
    expect(await shim.custom.add(addRequest({ args: ['--name="x"'] }))).toMatchObject({ outcome: 'refused', code: 'unsafe_path' })
    expect(await createWorld({ platform: 'win32', picks: ['C:\\tools\\agent.cmd'] }).custom.add(addRequest())).toMatchObject({
      outcome: 'connected'
    })
    expect([...script.log, ...shim.log]).toEqual(['pick', 'pick'])
  })

  it('refuses a picked path holding control or bidi characters, so the confirmation cannot misshow it', async () => {
    for (const pick of ['/opt/evil\u202Etxt.sh', '/opt/two\nlines']) {
      const world = createWorld({ picks: [pick] })
      expect(await world.custom.add(addRequest())).toMatchObject({ outcome: 'refused', code: 'unsafe_path' })
      expect(world.log).toEqual(['pick'])
    }
  })

  it('accepts a script or a Windows shim the launch rules accept: the terminal runs the program as picked, no SDK follows it', async () => {
    expect(await createWorld({ picks: ['/opt/agent.js'] }).custom.add(addRequest({ args: [] }))).toMatchObject({ outcome: 'connected' })
    expect(await createWorld({ platform: 'win32', picks: ['C:\\tools\\agent.cmd'] }).custom.add(addRequest({ args: [] }))).toMatchObject({
      outcome: 'connected'
    })
  })
})

describe('adding custom CLIs at the same time', () => {
  it('refuses a second add of the same name while the first is still open, and the duplicate once it is stored', async () => {
    const pick = deferred<string | null>()
    const world = createWorld({ picks: [pick.promise, PROGRAM, PROGRAM] })

    const first = world.custom.add(addRequest({ name: 'Twin' }))
    expect(await rejectionOf(world.custom.add(addRequest({ name: 'twin' })))).toMatchObject({ code: 'conflict' })
    const other = connected(await world.custom.add(addRequest({ name: 'Other' })))
    pick.resolve(PROGRAM)

    expect(connected(await first).displayName).toBe('Twin')
    expect(await rejectionOf(world.custom.add(addRequest({ name: 'TWIN' })))).toMatchObject({ code: 'conflict' })
    expect(world.registry.list().map((agent) => agent.id)).toEqual([other.id, expect.stringMatching(CUSTOM_ID)])
    expect(world.registry.list()).toHaveLength(2)
  })

  it('frees the name once an add is cancelled at the pick or the confirmation', async () => {
    const world = createWorld({ picks: [null, PROGRAM, PROGRAM], answers: [false] })

    expect(await world.custom.add(addRequest())).toEqual({ outcome: 'cancelled' })
    expect(await world.custom.add(addRequest())).toEqual({ outcome: 'cancelled' })
    expect((await world.custom.add(addRequest())).outcome).toBe('connected')
  })
})

async function addedWorld(options: WorldOptions = {}): Promise<{ world: World; id: string }> {
  const world = createWorld({ ...options, picks: [PROGRAM, ...(options.picks ?? [])] })
  const id = connected(await world.custom.add(addRequest())).id
  world.log.length = 0
  world.confirmations.length = 0
  return { world, id }
}

function editRequest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: 'Renamed', args: ['--acp'], repick: false, ...overrides }
}

describe('editing a custom CLI', () => {
  it('keeps the program without repick, and stores the new name and arguments after confirming', async () => {
    const { world, id } = await addedWorld()

    const agent = connected(await world.custom.update(editRequest(id)))

    expect(world.log).toEqual(['confirm'])
    expect(world.confirmations).toEqual([{ action: 'edit', name: 'Renamed', executablePath: PROGRAM, args: ['--acp'] }])
    expect(agent).toMatchObject({ id, kind: 'custom', displayName: 'Renamed', executablePath: PROGRAM, args: ['--acp'], version: null, needsReview: false })
    expect(world.registry.list()).toEqual([agent])
  })

  it('opens the file dialog only with repick, and uses the new pick', async () => {
    const { world, id } = await addedWorld({ picks: ['/opt/other-agent'] })

    const agent = connected(await world.custom.update(editRequest(id, { repick: true })))

    expect(world.log).toEqual(['pick', 'confirm'])
    expect(agent.executablePath).toBe('/opt/other-agent')
  })

  it('changes nothing when the repick or the confirmation says no', async () => {
    const { world, id } = await addedWorld({ picks: [null], answers: [true, false] })
    const before = world.registry.list()

    expect(await world.custom.update(editRequest(id, { repick: true }))).toEqual({ outcome: 'cancelled' })
    expect(await world.custom.update(editRequest(id))).toEqual({ outcome: 'cancelled' })
    expect(world.registry.list()).toEqual(before)
  })

  it('cannot set a protocol, the program or the review mark: those keys are refused', async () => {
    const { world, id } = await addedWorld()
    const before = world.registry.list()

    for (const extra of [{ protocol: 'codex' }, { executablePath: '/bin/sh' }, { path: '/bin/sh' }, { needsReview: false }]) {
      expect((await rejectionOf(world.custom.update(editRequest(id, extra)))).code).toBe('invalid_input')
    }
    expect(world.log).toEqual([])
    expect(world.registry.list()).toEqual(before)
  })
})

/** A custom CLI as the v3 migration leaves a row saved for ACP or Codex app-server: marked for review. */
async function flaggedWorld(options: WorldOptions = {}): Promise<{ world: World; id: string }> {
  const added = await addedWorld(options)
  added.world.db.run('UPDATE agents SET needs_review = 1 WHERE id = ?', added.id)
  return added
}

describe('reviewing a custom CLI marked for review', () => {
  it('shows its arguments in the native confirmation as a review, and once confirmed it no longer needs review', async () => {
    const { world, id } = await flaggedWorld()
    expect(world.registry.get(id)?.needsReview).toBe(true)

    const agent = connected(await world.custom.update(editRequest(id, { name: 'My agent', args: ['{folder}'] })))

    expect(world.confirmations).toEqual([{ action: 'review', name: 'My agent', executablePath: PROGRAM, args: ['{folder}'] }])
    expect(agent).toMatchObject({ id, needsReview: false, args: ['{folder}'] })
    expect(world.registry.get(id)?.needsReview).toBe(false)
  })

  it('keeps the mark when the confirmation is declined or the repick cancelled', async () => {
    const { world, id } = await flaggedWorld({ picks: [null], answers: [true, false] })

    expect(await world.custom.update(editRequest(id))).toEqual({ outcome: 'cancelled' })
    expect(await world.custom.update(editRequest(id, { repick: true }))).toEqual({ outcome: 'cancelled' })
    expect(world.registry.get(id)?.needsReview).toBe(true)
  })

  it('keeps the mark when the reviewed command fails the launch rules', async () => {
    const { world, id } = await flaggedWorld({ picks: ['/opt/evil\u202Etxt'] })

    expect(await world.custom.update(editRequest(id, { repick: true }))).toMatchObject({ outcome: 'refused', code: 'unsafe_path' })
    expect(world.confirmations).toEqual([])
    expect(world.registry.get(id)?.needsReview).toBe(true)
  })
})

describe('editing a custom CLI: refusals', () => {
  it('validates the new name and arguments like an add', async () => {
    const { world, id } = await addedWorld()

    for (const change of [{ name: 'a'.repeat(65) }, { name: 'bad\u202Ename' }, { args: ['--dir={folder}'] }, { args: ['x'.repeat(1025)] }, { repick: 'yes' }]) {
      expect((await rejectionOf(world.custom.update(editRequest(id, change)))).code).toBe('invalid_input')
    }
    expect(world.log).toEqual([])
  })

  it('refuses a built-in id with invalid_input and an unknown custom id with not_found', async () => {
    const { world } = await addedWorld()
    world.registry.upsert({ kind: 'codex', executablePath: '/bin/codex', version: null, connectedVia: 'found' })

    expect((await rejectionOf(world.custom.update(editRequest('codex')))).code).toBe('invalid_input')
    expect((await rejectionOf(world.custom.update(editRequest('cu_01m61r9qvzjh2yyk89xbzd67dn')))).code).toBe('not_found')
    expect(world.log).toEqual([])
  })

  it('refuses a name another custom CLI has, but keeps its own in another case', async () => {
    const { world, id } = await addedWorld({ picks: [PROGRAM] })
    await world.custom.add(addRequest({ name: 'Taken' }))

    expect((await rejectionOf(world.custom.update(editRequest(id, { name: 'TAKEN' })))).code).toBe('conflict')
    expect(connected(await world.custom.update(editRequest(id, { name: 'MY AGENT' }))).displayName).toBe('MY AGENT')
  })

  it('stores nothing when the agent was removed while its edit was confirmed', async () => {
    const answer = deferred<boolean>()
    const { world, id } = await addedWorld({ answers: [true, answer.promise] })

    // The edit has read the agent (synchronously); it is removed before the edit can store anything.
    const editing = world.custom.update(editRequest(id))
    world.registry.remove(id)
    answer.resolve(true)

    expect((await rejectionOf(editing)).code).toBe('not_found')
    expect(world.registry.list()).toEqual([])
  })
})

describe('removing a custom CLI', () => {
  it('clears its folder defaults through the cascade', async () => {
    const { world, id } = await addedWorld()
    const defaults = createFolderAgentDefaults({ db: world.db, now: () => STAMP })
    defaults.set('/repos/a', id)

    world.registry.remove(id)

    expect(defaults.get('/repos/a')).toBeNull()
  })
})

describe('the native dialogs', () => {
  const confirmation: CustomAgentConfirmation = {
    action: 'add',
    name: 'My agent',
    executablePath: 'C:\\Tools\\my agent.exe',
    args: ['--acp', '{folder}', ' spaced ']
  }

  it('shows the exact program and each argument on its own numbered line, and no protocol; Cancel is the default', () => {
    const options = customAgentDialogOptions(confirmation)

    expect(options.detail).toContain('Program: C:\\Tools\\my agent.exe')
    expect(options.detail).toContain('1. "--acp"')
    expect(options.detail).toContain('2. "{folder}"')
    expect(options.detail).toContain('3. " spaced "')
    expect(options.detail).not.toMatch(/protocol|Codex app-server|Claude Code SDK/i)
    expect(options.message).toContain('My agent')
    expect(options.buttons[options.cancelId]).toBe('Cancel')
    expect(options.defaultId).toBe(options.cancelId)
  })

  it('says the command runs in a chat terminal, and nothing is run to check it now', () => {
    const options = customAgentDialogOptions(confirmation)

    expect(options.detail).toContain("It runs in a chat's terminal whenever a chat uses it")
    expect(options.detail).not.toMatch(/runs once now|temporary folder|handshake/i)
  })

  it('says when there are no arguments, and titles an edit as one', () => {
    const options = customAgentDialogOptions({ ...confirmation, action: 'edit', args: [] })

    expect(options.detail).toContain('Arguments: none')
    expect(options.title).toMatch(/edit/i)
  })

  it('shows each argument as a JSON string, so an argument holding quotes cannot pass for several', () => {
    const options = customAgentDialogOptions({ ...confirmation, args: ['--model', 'opus" "--permission-mode" "plan'] })

    expect(options.detail).toContain('1. "--model"')
    expect(options.detail).toContain('2. "opus\\" \\"--permission-mode\\" \\"plan"')
    expect(options.detail).not.toContain('3.')
  })

  it('asks for a ticked checkbox, unticked at first, besides the click', () => {
    const options = customAgentDialogOptions(confirmation)

    expect(options.checkboxLabel).toBe('I have checked this command')
    expect(options.checkboxChecked).toBe(false)
  })

  it('approves only a click on Run and save with the checkbox ticked', () => {
    expect(customAgentApproved({ response: 0, checkboxChecked: true })).toBe(true)
    expect(customAgentApproved({ response: 0, checkboxChecked: false })).toBe(false)
    expect(customAgentApproved({ response: 1, checkboxChecked: true })).toBe(false)
    expect(customAgentApproved({ response: 1, checkboxChecked: false })).toBe(false)
  })
})

describe('the native confirmation of a review', () => {
  const confirmation: CustomAgentConfirmation = { action: 'review', name: 'My agent', executablePath: '/opt/tools/my-agent', args: ['--acp'] }

  it('titles a review as one, and says why the arguments are asked for again', () => {
    const options = customAgentDialogOptions(confirmation)

    expect(options.title).toBe('Review a custom CLI')
    expect(options.detail).toContain('1. "--acp"')
    expect(options.detail).toMatch(/saved before chats ran in a terminal/)
    expect(customAgentDialogOptions({ ...confirmation, action: 'edit' }).detail).not.toMatch(/saved before chats/)
  })
})

describe('the executable picker', () => {
  it('opens files only, with hidden folders reachable, links kept as picked and Windows programs listed first', () => {
    // noResolveAliases: macOS would otherwise hand back ~/.local/bin/claude as its versioned target.
    expect(customExecutableDialogOptions('darwin').properties).toEqual(['openFile', 'showHiddenFiles', 'noResolveAliases'])
    expect(customExecutableDialogOptions('win32').filters[0]).toEqual({ name: 'Programs', extensions: ['exe', 'cmd'] })
  })
})

describe.runIf(process.platform !== 'win32')('a custom CLI picked through a symlink', () => {
  it('stores, confirms and hands over the link as picked, not its target, and the real file check accepts it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'dm-custom-link-'))
    try {
      const target = join(scratch, 'versions', '2.1.291')
      mkdirSync(join(scratch, 'versions'))
      writeFileSync(target, '#!/bin/sh\n')
      chmodSync(target, 0o755)
      const link = join(scratch, 'claude')
      symlinkSync(target, link)
      const world = createWorld({ picks: [link], inspect: inspectExecutable })

      const agent = connected(await world.custom.add(addRequest({ args: [] })))

      expect(agent.executablePath).toBe(link)
      expect(world.confirmations[0]?.executablePath).toBe(link)
      expect(customAgentDialogOptions(world.confirmations[0]!).detail).toContain(`Program: ${link}`)
      expect(world.registry.get(agent.id)?.executablePath).toBe(link)
    } finally {
      removeScratch(scratch)
    }
  })
})

describe('no handshake is left to run', () => {
  const SRC = fileURLToPath(new URL('../..', import.meta.url))

  it('has no protocolHandshake module, and no source file imports one', () => {
    expect(existsSync(join(SRC, 'main', 'agents', 'protocolHandshake.ts'))).toBe(false)
    const importers = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.tsx?$/.test(path))
      .filter((path) => /from\s+['"][^'"]*protocolHandshake['"]|import\(\s*['"][^'"]*protocolHandshake/.test(readFileSync(join(SRC, path), 'utf8')))
    expect(importers).toEqual([])
  })
})
