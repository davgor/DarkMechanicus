/**
 * The files main writes before a terminal starts: the chat's instructions, rewritten at each start, and on macOS
 * the chat's `dm` launcher, which the instructions name by its absolute path. The orchestrator chat Start run opened
 * also has the orchestrator and worker guidance in its instructions.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { removeScratch } from '../../test/removeScratch'
import { transferGuidance } from '../../mcp/transferKickoff'
import { cliCommandLine, skitariiMailGuidance } from '../agents/cliInstructions'
import { kanbanGuidance } from '../agents/kanbanKickoff'
import { orchestratorGuidance, orchestratorKickoff } from '../agents/orchestratorKickoff'
import { dmClientDescriptorPath, removeDmClientDescriptor, terminalFilePaths, terminalInstructions, writeDmClientDescriptor, writeTerminalFiles } from './terminalFiles'
import { parseDmClientDescriptor } from '../../../resources/skitarii/extension/dmClient'
import { MAIL_TOOL_NAMES } from '../../../resources/skitarii/extension/messaging'
import { ompFilePaths } from './ompSession'
import { terminalLaunchSpec } from './terminalLaunchSpec'

const FOLDER = '/Users/me/My Repo'

function cliFor(folder: string): DarkMechanicusCli {
  return {
    command: '/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus',
    args: ['/Applications/Dark Mechanicus.app/Contents/Resources/app.asar/out/main/cli.js', '--repo', folder],
    env: { ELECTRON_RUN_AS_NODE: '1', DM_SESSION_TOKEN: 'grant-token' }
  }
}

describe('terminalFilePaths', () => {
  it('puts the instructions under agents/instructions and the macOS launcher under agents/bin/<chat id>', () => {
    expect(terminalFilePaths('/data', 'ch_1', 'darwin')).toEqual({ instructions: join('/data', 'agents', 'instructions', 'ch_1.md'), launcherDir: join('/data', 'agents', 'bin', 'ch_1') })
    expect(terminalFilePaths('/data', 'ch_1', 'win32')).toEqual({ instructions: join('/data', 'agents', 'instructions', 'ch_1.md'), launcherDir: null })
  })

  it('refuses a chat id that could name a path outside those folders', () => {
    for (const id of ['../ch_1', 'a/b', '', '.', 'x'.repeat(81)]) {
      expect(() => terminalFilePaths('/data', id, 'darwin')).toThrow(/chat id/)
    }
  })
})

describe('terminalInstructions: which dm is named', () => {
  it('on Windows the kickoff and the instructions name one runnable invocation: the pinned line, which the instructions say stands for dm', () => {
    const winCli: DarkMechanicusCli = { command: 'C:\\Program Files\\Dark Mechanicus\\Dark Mechanicus.exe', args: ['C:\\app.asar\\out\\main\\cli.js', '--repo', 'C:\\My Repo'], env: { ELECTRON_RUN_AS_NODE: '1', DM_SESSION_TOKEN: 't' } }
    const text = terminalInstructions({ cli: winCli, role: 'orchestrator', allowSave: false, launcherDir: null, orchestratesRun: true })
    const first = orchestratorKickoff({ epicId: 'ep_1', epicTitle: 'T', branch: null, runId: 'rn_1' })

    expect(text).toContain(`${cliCommandLine(winCli)} call get_capabilities '{}'`)
    expect(text).toContain('There is no `dm` program on this computer')
    expect(first).toContain("exactly as your instructions give it (ending `call get_capabilities '{}'`)")
    expect(first).not.toMatch(/`dm call|dm get_/)
  })

  it('does not say dm is missing where a launcher names it (macOS)', () => {
    const text = terminalInstructions({ cli: cliFor(FOLDER), role: 'worker', allowSave: false, launcherDir: '/data/agents/bin/ch_1', orchestratesRun: false })

    expect(text).not.toContain('There is no `dm` program')
  })
})

describe('terminalInstructions', () => {
  it('names the macOS launcher by its absolute path, not the runtime and script behind it', () => {
    const text = terminalInstructions({ cli: cliFor(FOLDER), role: 'planner', allowSave: true, launcherDir: '/data/agents/bin/ch_1', orchestratesRun: false })

    expect(text).toContain('/data/agents/bin/ch_1/dm --list')
    expect(text).not.toContain('cli.js')
    expect(text).toContain('**planner** grant')
    expect(text).toContain('This chat may save plans itself.')
  })

  it('names the dm command itself where there is no launcher (Windows)', () => {
    const text = terminalInstructions({ cli: cliFor(FOLDER), role: 'worker', allowSave: false, launcherDir: null, orchestratesRun: false })

    expect(text).toContain("'/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus' '/Applications/Dark Mechanicus.app/Contents/Resources/app.asar/out/main/cli.js' --repo '/Users/me/My Repo' --list")
    expect(text).toContain('This chat may not save plans')
  })

  it('never puts the grant token in the instructions', () => {
    expect(terminalInstructions({ cli: cliFor(FOLDER), role: 'worker', allowSave: false, launcherDir: null, orchestratesRun: false })).not.toContain('grant-token')
  })

  it('adds the orchestrator and worker guidance, after the dm instructions, only for a chat that orchestrates a run', () => {
    const options = { cli: cliFor(FOLDER), role: 'orchestrator', allowSave: false, launcherDir: '/data/agents/bin/ch_1' } as const
    const plain = terminalInstructions({ ...options, orchestratesRun: false })

    expect(terminalInstructions({ ...options, orchestratesRun: true })).toBe(`${plain}\n\n${orchestratorGuidance()}`)
    expect(plain).not.toContain('=== Orchestrator guidance')
  })

  it('adds the Linear transfer guidance, with the epic id and the start_transfer step, only for a transfer chat', () => {
    const options = { cli: cliFor(FOLDER), role: 'orchestrator', allowSave: false, launcherDir: '/data/agents/bin/ch_1', orchestratesRun: false } as const
    const plain = terminalInstructions(options)
    const transfer = terminalInstructions({ ...options, transferEpicId: 'ep_01m6772ffwkwr2a91fsqzfz1he' })

    expect(transfer).toBe(`${plain}\n\n${transferGuidance('ep_01m6772ffwkwr2a91fsqzfz1he')}`)
    expect(transfer).toContain('Call start_transfer for epic ep_01m6772ffwkwr2a91fsqzfz1he')
    expect(transfer).toContain('=== Linear transfer guidance ===')
    expect(plain).not.toContain('start_transfer')
  })

  it('adds the Kanban card guidance, with the card id and the claim step, only for the chat Play opened for a card', () => {
    const options = { cli: cliFor(FOLDER), role: 'orchestrator', allowSave: false, launcherDir: '/data/agents/bin/ch_1', orchestratesRun: false } as const
    const plain = terminalInstructions(options)
    const card = terminalInstructions({ ...options, cardId: 'kc_01m6a1p7qaxttbw9f5927qk2dx' })

    expect(card).toBe(`${plain}\n\n${kanbanGuidance('kc_01m6a1p7qaxttbw9f5927qk2dx')}`)
    expect(card).toContain('claim_kanban_card with cardId kc_01m6a1p7qaxttbw9f5927qk2dx')
    expect(plain).not.toContain('claim_kanban_card')
  })
})

describe('terminalInstructions: board conversations', () => {

  it('adds answer-only board guidance only for a chat bound to a board conversation', () => {
    const options = { cli: cliFor(FOLDER), role: 'orchestrator', allowSave: false, launcherDir: '/data/agents/bin/ch_1', orchestratesRun: false } as const
    const plain = terminalInstructions(options)
    const epic = terminalInstructions({ ...options, conversation: { epicId: 'ep_1' } })
    const card = terminalInstructions({ ...options, conversation: { cardId: 'kc_1' } })

    expect(plain).not.toContain('=== Board conversation guidance ===')
    expect(epic).toContain('Reply on the record with add_comment {"epicId":"ep_1"}')
    expect(card).toContain('Reply on the record with add_kanban_message {"cardId":"kc_1"}')
    for (const bound of [epic, card]) {
      expect(bound).toContain('Answer only')
      expect(bound).toContain('do not start or take over a run')
      expect(bound).toContain('claim work or save a plan unless the person explicitly asks')
    }
  })
})

describe('writeTerminalFiles: collaboration policy', () => {
  let userData: string
  let folder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
    folder = join(userData, 'repo')
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it.each(['planner', 'orchestrator', 'worker', 'reviewer'] as const)('loads collaboration for an ordinary %s chat without inventing a grant or task', async (role) => {
    const files = await writeTerminalFiles({ userData, chatId: 'ch_plain', platform: 'win32', folder, cli: cliFor(folder), role, allowSave: false, orchestratesRun: false })
    const text = readFileSync(files.instructions, 'utf8')

    expect(text).toContain(`**${role}** grant`)
    expect(text).toContain('Planning an epic')
    expect(text).toContain('meaningful questions')
    expect(text).toContain('in-scope decisions')
    expect(text).toContain('only the orchestrator')
    expect(text).toContain('does not grant permissions')
    expect(text).not.toMatch(/=== Orchestrator guidance|=== Linear transfer guidance|claim_kanban_card|grant-token/)
  })

  it('passes fresh policy to ordinary Skitarii on initial launch and replaces stale instructions before resume', async () => {
    const start = { userData, chatId: 'ch_plain', platform: 'darwin' as const, folder, cli: cliFor(folder), role: 'orchestrator' as const, allowSave: false, orchestratesRun: false }
    const sessionId = '019495d5-1234-7000-8000-000000000001'
    for (const resumed of [false, true]) {
      if (resumed) writeFileSync(terminalFilePaths(userData, start.chatId, start.platform).instructions, 'stale instructions from an older app')
      const files = await writeTerminalFiles(start)
      const spec = terminalLaunchSpec({
        chat: { agent: 'omp', role: start.role, allowSave: false, model: null, sessionId: resumed ? sessionId : null, sessionStarted: resumed, kickoffSent: resumed },
        kickoff: null,
        agent: { id: 'omp', kind: 'omp', executablePath: '/usr/local/bin/omp', args: [] },
        folder, cli: start.cli, files, platform: start.platform, env: {}, newSessionId: () => sessionId
      })
      const args = spec.args ?? []
      const instructions = args[args.indexOf('--append-system-prompt') + 1]
      expect(instructions).toBe(files.instructions)
      const text = readFileSync(instructions!, 'utf8')
      expect(text).toContain('Planning an epic')
      expect(text).toContain('only the orchestrator')
      expect(text).not.toContain('stale instructions')
      expect(spec.resumed).toBe(resumed)
      expect(args.includes('--resume')).toBe(resumed)
      expect(spec.kickoffIn).toBeNull()
    }
  })
})

describe('writeTerminalFiles: Skitarii mail guidance', () => {
  let userData: string
  let folder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
    folder = join(userData, 'repo')
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it('follows the policy, before task guidance, only in a Skitarii chat, and keeps the file token-free', async () => {
    const start = { userData, chatId: 'ch_omp', platform: 'darwin' as const, folder, cli: cliFor(folder), role: 'orchestrator' as const, allowSave: false, orchestratesRun: true }
    const plain = readFileSync((await writeTerminalFiles(start)).instructions, 'utf8')
    const text = readFileSync((await writeTerminalFiles({ ...start, skitariiMail: true })).instructions, 'utf8')

    expect(text).toBe(plain.replace(`\n\n${orchestratorGuidance()}`, `\n\n${skitariiMailGuidance()}\n\n${orchestratorGuidance()}`))
    expect(plain).not.toContain('## Skitarii mail')
    expect(text).not.toContain('grant-token')
  })

  it('names every native mail tool OMP registers', () => {
    const text = skitariiMailGuidance()
    for (const tool of MAIL_TOOL_NAMES) expect(text).toContain(`\`${tool}\``)
  })
})

describe('writeTerminalFiles', () => {
  let userData: string
  let folder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
    folder = join(userData, 'repo')
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it('writes the instructions and, on macOS, the launcher pinned to the folder, and returns where they are', async () => {
    const files = await writeTerminalFiles({ userData, chatId: 'ch_1', platform: 'darwin', folder, cli: cliFor(folder), role: 'planner', allowSave: false, orchestratesRun: false })

    const launcherDir = join(userData, 'agents', 'bin', 'ch_1')
    expect(files).toEqual({ instructions: join(userData, 'agents', 'instructions', 'ch_1.md'), launcherDir })
    expect(readFileSync(files.instructions, 'utf8')).toBe(terminalInstructions({ cli: cliFor(folder), role: 'planner', allowSave: false, launcherDir, orchestratesRun: false }))
    expect(readFileSync(join(launcherDir, 'dm'), 'utf8')).toContain(`--repo '${folder}' "$@"`)
  })

  it('rewrites the instructions at each start, and writes the guidance into those of a chat that orchestrates a run', async () => {
    const first = { userData, chatId: 'ch_1', platform: 'darwin' as const, folder, cli: cliFor(folder), role: 'planner' as const, allowSave: false, orchestratesRun: false }
    await writeTerminalFiles(first)

    const files = await writeTerminalFiles({ ...first, role: 'orchestrator', allowSave: true, orchestratesRun: true })

    const text = readFileSync(files.instructions, 'utf8')
    expect(text).toContain('**orchestrator** grant')
    expect(text).toContain('This chat may save plans itself.')
    expect(text.endsWith(orchestratorGuidance())).toBe(true)
  })
  it('lets two starts of one chat write at once, leaving one whole file and nothing staged beside it', async () => {
    const start = { userData, chatId: 'ch_1', platform: 'darwin' as const, folder, cli: cliFor(folder), role: 'planner' as const, allowSave: false, orchestratesRun: false }

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => writeTerminalFiles({ ...start, allowSave: index % 2 === 0 })))

    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    expect(readdirSync(join(userData, 'agents', 'instructions'))).toEqual(['ch_1.md'])
    expect(readdirSync(join(userData, 'agents', 'bin', 'ch_1'))).toEqual(['dm'])
  })

  it('writes no launcher on Windows', async () => {
    const files = await writeTerminalFiles({ userData, chatId: 'ch_2', platform: 'win32', folder, cli: cliFor(folder), role: 'worker', allowSave: false, orchestratesRun: false })

    expect(files.launcherDir).toBeNull()
    expect(existsSync(join(userData, 'agents', 'bin'))).toBe(false)
    expect(readFileSync(files.instructions, 'utf8')).toContain(`${cliCommandLine(cliFor(folder))} --list`)
  })

  it('refuses a dm command pinned to another folder, and writes nothing', async () => {
    const pinnedElsewhere = { userData, chatId: 'ch_3', platform: 'darwin' as const, folder, cli: cliFor('/elsewhere'), role: 'worker' as const, allowSave: false, orchestratesRun: false }

    await expect(writeTerminalFiles(pinnedElsewhere)).rejects.toThrow(/--repo/)
    await expect(writeTerminalFiles({ ...pinnedElsewhere, platform: 'win32' })).rejects.toThrow(/--repo/)
    expect(existsSync(join(userData, 'agents'))).toBe(false)
  })
})

// Windows keeps no POSIX permission bits: it reports any writable file as 0666.
describe.skipIf(process.platform === 'win32')('writeTerminalFiles: permissions', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it('makes the macOS launcher 0700 and the instructions 0600', async () => {
    const folder = join(userData, 'repo')
    const files = await writeTerminalFiles({ userData, chatId: 'ch_1', platform: 'darwin', folder, cli: cliFor(folder), role: 'planner', allowSave: false, orchestratesRun: false })

    expect([statSync(join(files.launcherDir as string, 'dm')).mode & 0o777, statSync(files.instructions).mode & 0o777]).toEqual([0o700, 0o600])
  })

  it('keeps a Skitarii chat’s launcher 0700 and its instructions with the mail guidance 0600', async () => {
    const folder = join(userData, 'repo')
    const files = await writeTerminalFiles({ userData, chatId: 'ch_omp', platform: 'darwin', folder, cli: cliFor(folder), role: 'worker', allowSave: false, orchestratesRun: false, skitariiMail: true })

    expect([statSync(join(files.launcherDir as string, 'dm')).mode & 0o777, statSync(files.instructions).mode & 0o777]).toEqual([0o700, 0o600])
  })

  it('makes the mail client descriptor 0600 in a 0700 folder', async () => {
    const folder = join(userData, 'repo')
    const path = await writeDmClientDescriptor({ userData, chatId: 'ch_1', generation: 'gen-1', folder, cli: cliFor(folder), platform: 'darwin' })

    expect([statSync(join(path, '..')).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600])
  })
})

describe('writeDmClientDescriptor: the private file a launch’s mail client reads', () => {
  let userData: string
  let folder: string
  const write = (generation: string, platform: NodeJS.Platform = 'win32', cli = cliFor(folder)): Promise<string> =>
    writeDmClientDescriptor({ userData, chatId: 'ch_1', generation, folder, cli: { ...cli, env: { ...cli.env, DARKMECHANICUS_HOME: join(userData, 'home'), DM_DESKTOP_PIPE: '\\\\.\\pipe\\naming' } }, platform })

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
    folder = join(userData, 'repo')
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it('puts it in the chat’s own OMP folder, named by the launch, and pins the runtime, script and folder', async () => {
    const path = await write('gen-1')

    expect(path).toBe(join(ompFilePaths(userData, 'ch_1').sessionDir, '..', 'dm-client', 'gen-1.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      chatId: 'ch_1',
      generation: 'gen-1',
      folder,
      command: cliFor(folder).command,
      args: [cliFor(folder).args[0], '--repo', folder],
      cwd: folder,
      env: { ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: join(userData, 'home') },
      recoveryAddress: '\\\\.\\pipe\\naming',
      inherit: ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH']
    })
  })

  it('pins only the typed recovery address outside child environment, never a grant or shell command', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const path = await write(`gen-${platform}`, platform)
      const text = readFileSync(path, 'utf8')
      expect(text).not.toContain('grant-token')
      const parsed = parseDmClientDescriptor(path, text)
      expect(parsed).toMatchObject({ ok: true, value: { generation: `gen-${platform}`, recoveryAddress: '\\\\.\\pipe\\naming', command: cliFor(folder).command } })
      expect(JSON.parse(text).env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: join(userData, 'home') })
      expect(JSON.parse(text)).not.toHaveProperty('token')
    }
  })

  it('leaves only the newest launch’s descriptor, and removes it when that launch ends', async () => {
    const first = await write('gen-1')
    const second = await write('gen-2')

    expect(existsSync(first)).toBe(false)
    expect(readdirSync(join(second, '..'))).toEqual(['gen-2.json'])
    await removeDmClientDescriptor(second)
    await removeDmClientDescriptor(second)
    expect(readdirSync(join(second, '..'))).toEqual([])
  })
})

describe('writeDmClientDescriptor: what it refuses', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it('refuses a launch generation that is not a plain id, a chat id that is not one, and an unpinned dm command, writing nothing', async () => {
    const folder = join(userData, 'repo')
    const write = (cli: DarkMechanicusCli): Promise<string> => writeDmClientDescriptor({ userData, chatId: 'ch_1', generation: 'gen-1', folder, cli, platform: 'win32' })
    for (const generation of ['', '../gen', 'a/b', 'x'.repeat(129)]) {
      expect(() => dmClientDescriptorPath(userData, 'ch_1', generation)).toThrow(/launch generation/)
    }
    expect(() => dmClientDescriptorPath(userData, '../ch_1', 'gen')).toThrow(/chat id/)
    await expect(write(cliFor('/elsewhere'))).rejects.toThrow(/pinned/)
    await expect(write({ ...cliFor(folder), command: 'electron' })).rejects.toThrow(/absolute runtime/)
    expect(existsSync(join(userData, 'agents'))).toBe(false)
  })
})

describe('writeTerminalFiles: a task chat', () => {
  let userData: string
  let folder: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'dm-terminal-files-'))
    folder = join(userData, 'repo')
  })

  afterEach(() => {
    removeScratch(userData)
  })

  it("writes a transfer chat's and a card chat's task into their instructions, so a start on a new session still has it", async () => {
    const start = { userData, platform: 'darwin' as const, folder, cli: cliFor(folder), role: 'orchestrator' as const, allowSave: false, orchestratesRun: false }

    const transfer = await writeTerminalFiles({ ...start, chatId: 'ch_1', transferEpicId: 'ep_01m6772ffwkwr2a91fsqzfz1he' })
    const card = await writeTerminalFiles({ ...start, chatId: 'ch_2', cardId: 'kc_01m6a1p7qaxttbw9f5927qk2dx' })

    expect(readFileSync(transfer.instructions, 'utf8').endsWith(transferGuidance('ep_01m6772ffwkwr2a91fsqzfz1he'))).toBe(true)
    expect(readFileSync(card.instructions, 'utf8').endsWith(kanbanGuidance('kc_01m6a1p7qaxttbw9f5927qk2dx'))).toBe(true)
  })
})
