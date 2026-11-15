/**
 * A project-less chat's terminal: it starts in its own scratch folder under userData, holds one grant per tracked,
 * set-up folder (stored on the chat before the spawn), and every way out revokes all of them: its exit, deleting the
 * chat, removing its agent. With no folder to reach, nothing starts.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProjectName } from './claudeSession'
import { eventually, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

let rig: TerminalRig
let other: string

beforeEach(() => {
  rig = terminalRig()
  other = join(rig.root, 'other')
  mkdirSync(other)
  rig.reach = [rig.repo, other]
})

afterEach(() => {
  rig.cleanup()
})

function scratchOf(chatId: string): string {
  return realpathSync.native(join(rig.userData, 'agents', 'scratch', chatId))
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort()

describe('terminal sessions: a project-less chat', () => {
  it('starts in its own scratch folder with one grant per reached folder, all stored on the chat before the spawn', async () => {
    const chat = rig.newProjectless()

    const { pty } = await startTerminal(rig, chat)

    expect(pty.spec.cwd).toBe(scratchOf(chat.id))
    expect(rig.reachIssued).toHaveLength(1)
    expect(rig.reachIssued[0]?.map((target) => target.folder)).toEqual([rig.repo, other])
    for (const target of rig.reachIssued[0] ?? []) {
      expect(target.tokenFile.startsWith(join(scratchOf(chat.id), '.dm', 'grants'))).toBe(true)
    }
    expect(rig.steps).toEqual(['auth', 'grant:gr_1', 'grant:gr_2', 'spawn'])
    expect(rig.host.grantStoredAtSpawn).toEqual([true])
    expect(rig.reopenedStore().getChat({ folder: null, id: chat.id })?.grantIds).toEqual(['gr_1', 'gr_2'])
  })

  it('tells the agent how to reach each folder, through a dm pinned to none', async () => {
    const chat = rig.newProjectless()

    await startTerminal(rig, chat)

    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    const launcher = readFileSync(join(rig.userData, 'agents', 'bin', chat.id, 'dm'), 'utf8')
    expect(instructions).toContain('not tied to a project')
    const lines = instructions.split('\n')
    for (const target of rig.reachIssued[0] ?? []) {
      const named = (line: string): boolean => /--repo \S+ --token-file \S+ call get_capabilities/.test(line) && line.includes(target.folder) && line.includes(target.tokenFile)
      expect(lines.some(named)).toBe(true)
    }
    expect(launcher).not.toContain('--repo')
  })

  it('revokes every grant when its CLI exits', async () => {
    const { pty } = await startTerminal(rig, rig.newProjectless())

    pty.exit()

    await eventually(() => rig.revoked.length === 2, 'both grants to be revoked')
    expect(sorted(rig.revoked)).toEqual(['gr_1', 'gr_2'])
  })

  it('renews every grant while it runs', async () => {
    await startTerminal(rig, rig.newProjectless())

    rig.clock.advance(60 * 60_000)

    await eventually(() => rig.renewed.length === 2, 'both grants to be renewed')
    expect(sorted(rig.renewed)).toEqual(['gr_1', 'gr_2'])
  })

  it('deleting it ends its terminal and revokes every grant before the record goes', async () => {
    const chat = rig.newProjectless()
    const { pty } = await startTerminal(rig, chat)
    const atRemoval: string[][] = []

    const deleting = rig.sessions.deleteChat(chat, async () => {
      atRemoval.push(sorted(rig.revoked))
    })
    pty.exit()
    await deleting

    expect(pty.kills).toBe(1)
    expect(atRemoval).toEqual([['gr_1', 'gr_2']])
  })

  it('removing its agent ends its terminal and revokes every grant', async () => {
    const { pty } = await startTerminal(rig, rig.newProjectless())

    const ending = rig.sessions.endAgent('claude')
    pty.exit()
    await ending

    expect(pty.kills).toBe(1)
    expect(sorted(rig.revoked)).toEqual(['gr_1', 'gr_2'])
  })

  it('starts with no grant and says so while no tracked folder is set up, reaching folders tracked later from its next start', async () => {
    rig.reach = []
    const chat = rig.newProjectless()

    const { pty } = await startTerminal(rig, chat)

    expect(pty.spec.cwd).toBe(scratchOf(chat.id))
    expect(rig.grantsAsked).toBe(0)
    expect(Object.keys(pty.spec.env).some((name) => name.toUpperCase() === 'DM_SESSION_TOKEN')).toBe(false)
    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(instructions).toContain('No folder is tracked and set up')
    expect(instructions).not.toContain('--token-file')
    pty.exit()

    rig.reach = [rig.repo]
    await settle()
    await startTerminal(rig, chat)
    expect(rig.reachIssued.map((targets) => targets.map((target) => target.folder))).toEqual([[rig.repo]])
  })

  it('resumes its Claude session in the same scratch folder when it starts again', async () => {
    const chat = rig.newProjectless()
    const first = await startTerminal(rig, chat)
    const sessionId = rig.store.getChat(chat)?.sessionId ?? ''
    const project = join(rig.root, '.claude', 'projects', claudeProjectName(scratchOf(chat.id)))
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, `${sessionId}.jsonl`), '{"type":"user"}\n')
    first.pty.exit()
    await eventually(() => rig.revoked.length === 2, 'the first terminal to end')

    const again = await startTerminal(rig, chat)

    expect(again.pty.spec.cwd).toBe(scratchOf(chat.id))
    expect(again.pty.spec.args).toEqual(expect.arrayContaining(['--resume', sessionId]))
    expect(rig.reachIssued).toHaveLength(2)
  })
})
