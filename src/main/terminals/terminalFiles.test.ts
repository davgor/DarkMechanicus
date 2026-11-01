/**
 * The files main writes before a terminal starts: the chat's instructions, rewritten at each start, and on macOS
 * the chat's `dm` launcher, which the instructions name by its absolute path. The orchestrator chat Start run opened
 * also has the orchestrator and worker guidance in its instructions.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { removeScratch } from '../../test/removeScratch'
import { transferGuidance } from '../../mcp/transferKickoff'
import { kanbanGuidance } from '../agents/kanbanKickoff'
import { orchestratorGuidance } from '../agents/orchestratorKickoff'
import { terminalFilePaths, terminalInstructions, writeTerminalFiles } from './terminalFiles'

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
    expect(statSync(join(launcherDir, 'dm')).mode & 0o777).toBe(0o700)
    expect(statSync(files.instructions).mode & 0o777).toBe(0o600)
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
    expect(readFileSync(files.instructions, 'utf8')).toContain(`--repo ${folder} --list`)
  })

  it('refuses a dm command pinned to another folder, and writes nothing', async () => {
    const pinnedElsewhere = { userData, chatId: 'ch_3', platform: 'darwin' as const, folder, cli: cliFor('/elsewhere'), role: 'worker' as const, allowSave: false, orchestratesRun: false }

    await expect(writeTerminalFiles(pinnedElsewhere)).rejects.toThrow(/--repo/)
    await expect(writeTerminalFiles({ ...pinnedElsewhere, platform: 'win32' })).rejects.toThrow(/--repo/)
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
