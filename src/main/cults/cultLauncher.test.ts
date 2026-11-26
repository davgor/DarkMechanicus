/**
 * Launching cult runs over the real pieces: desktop workspaces (the sanctum's in db mode, on a folder that is not a Git
 * repository, through the real Git adapter), real chat grants with mailbox binding, the cult store on a real app
 * database, the sanctum registry on disk, and the terminal session manager on the fake PTY host (`terminalSessionsRig`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { dbProjectDir } from '../../core/repo/storageMode'
import { openWorkspace } from '../../core/workspace'
import { chatRecordSchema, type ChatRecord } from '../../shared/agents/chat'
import type { CultInput } from '../../shared/cults/cult'
import type { TrackedFolderView } from '../../shared/desktop/api'
import { removeScratch } from '../../test/removeScratch'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { TEST_STORAGE } from '../../test/workspaceHarness'
import { builtInAgent, connectedAgents } from '../agents/__mocks__/chatFixtures'
import { createChatGrants, type ChatGrants } from '../agents/chatGrants'
import { createChatHandlers, type ChatHandlers } from '../agents/chatHandlers'
import { createChatRecords, type ChatRecords } from '../agents/chatRecords'
import { resolveLaunchFolder } from '../agents/launchFolder'
import { createTestWorkspacePool, type TestWorkspacePool } from '../desktop/__mocks__/projectWorkspaceFixture'
import { ompFilePaths, removeOmpFolder } from '../terminals/ompSession'
import { terminalFilePaths } from '../terminals/terminalFiles'
import { endingTerminals } from '../terminals/terminalSessions'
import { cliFor, settle, terminalRig, type TerminalRig } from '../terminals/__mocks__/terminalSessionsRig'
import type { FakePty } from '../terminals/__mocks__/fakePtyHost'
import { openAppDatabase } from '../desktop/appDatabase'
import { cheapest, parseOmpModels } from './ompModels'
import { createCultLauncher, GRACEFUL_EXIT_MS, type CultLauncher } from './cultLauncher'
import { createCultStore, type CultStore } from './cultStore'
import { createSanctumRegistry, withSanctums, type SanctumRegistry } from './sanctumRegistry'

const MODELS = readFileSync(new URL('./__fixtures__/omp-models.json', import.meta.url), 'utf8')
const CHEAPEST = cheapest(parseOmpModels(MODELS, ['anthropic']) ?? [])!.id
const MAGOS_MODEL = 'anthropic/claude-opus-4-5'
const CHARTER = 'Polish the brass reliquary until it reflects the Omnissiah.'

interface Harness {
  rig: TerminalRig
  pool: TestWorkspacePool
  cults: CultStore
  sanctums: SanctumRegistry
  gates: { resolve(path: string): string | null; list(): TrackedFolderView[] }
  records: ChatRecords
  launcher: CultLauncher
  handlers: ChatHandlers
  dmHome: string
}

let h: Harness

function workspacePool(root: string, dmHome: string): TestWorkspacePool {
  const clock = createTestClock('2026-11-26T09:00:00.000Z')
  const ids = createSequentialIds()
  // No fake Git: the sanctum is a plain folder, and the real adapter must cope with that.
  return createTestWorkspacePool((repoRoot) =>
    openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir: dmHome, clock, ids, ...TEST_STORAGE })
  , root)
}

/** The same gates main has: tracked folders (the rig's), then registered sanctums. */
function gatesOf(rig: TerminalRig, sanctums: SanctumRegistry): Harness['gates'] {
  const folders = {
    resolve: (path: string) => (rig.tracked.has(path) ? path : null),
    list: () => [...rig.tracked].map((path) => ({ path }) as TrackedFolderView)
  }
  return withSanctums(folders, sanctums)
}

function grantsOver(gates: Harness['gates'], pool: TestWorkspacePool) {
  return createChatGrants({
    workspaceFor: (folder) => {
      if (gates.resolve(folder) !== folder) throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
      return pool.get(folder)
    },
    cliFor,
    minutes: 12 * 60,
    log: () => {}
  })
}

function handlersOver(gates: Harness['gates'], records: ChatRecords): ChatHandlers {
  const unused = {} as never
  return createChatHandlers({ registry: gates, agents: { get: () => builtInAgent('omp') }, chats: records, terminals: unused, runs: unused, transfers: unused, kanban: unused })
}

async function harness(): Promise<Harness> {
  let grants: ChatGrants | null = null
  const late = { gates: null as Harness['gates'] | null }
  const rig = terminalRig({
    agents: [builtInAgent('omp')],
    killSettlesAtOnce: true,
    deps: () => ({
      folders: { trackedFolder: (path) => late.gates!.resolve(path) },
      issueChatCli: (folder, grant, chat) => grants!.issueChatCli(folder, grant, chat),
      revokeChatGrant: async (grantId) => {
        rig.revoked.push(grantId)
        await grants!.revokeChatGrant(grantId)
      }
    })
  })
  const dmHome = join(rig.root, 'dm-home')
  const pool = workspacePool(rig.root, dmHome)
  await pool.get(rig.repo).initializeRepository({ name: 'repo', mode: 'db' })
  const sanctums = createSanctumRegistry({ userData: rig.userData })
  const gates = (late.gates = gatesOf(rig, sanctums))
  grants = grantsOver(gates, pool)
  const records = endingTerminals(
    createChatRecords({ store: rig.store, agentFor: connectedAgents([builtInAgent('omp')]), removeOmpFolder: (id) => removeOmpFolder(rig.userData, id) }),
    rig.sessions
  )
  const db = openAppDatabase(mkdtempSync(join(rig.root, 'app-')))
  const cults = createCultStore({ db })
  const launcher = createCultLauncher({
    cults, folders: { resolve: (path) => (rig.tracked.has(path) ? path : null) }, sanctums, chats: records, terminals: rig.sessions,
    workspaceFor: (folder) => {
      if (gates.resolve(folder) !== folder) throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
      const workspace = pool.get(folder)
      // The chat store keeps chats only in folders it can find; a sanctum is one from now on.
      rig.chatFs.folders.add(folder)
      return workspace
    },
    closeWorkspace: (folder) => pool.close(folder),
    cheapestModel: async () => CHEAPEST,
    userData: rig.userData,
    dmHome
  })
  return { rig, pool, cults, sanctums, gates, records, launcher, handlers: handlersOver(gates, records), dmHome }
}

beforeEach(async () => {
  h = await harness()
})

afterEach(async () => {
  // A fake PTY only records a kill; it exits when told, so the quit has every exit to wait for.
  const disposing = h.rig.sessions.dispose()
  for (const pty of h.rig.host.spawns) if (!pty.exited) pty.exit({ exitCode: 0, signal: null })
  await disposing
  await h.pool.closeAll()
  removeScratch(h.rig.root)
})

function folderCult(overrides: Partial<CultInput> = {}): CultInput {
  return {
    name: 'Order of the Cog', charter: CHARTER, scope: 'folder', folderPath: h.rig.repo, archetype: 'general',
    magosName: 'Magos Ferrum', magosModelId: MAGOS_MODEL, defaultTimeLimitMs: 60 * 60_000, ...overrides
  }
}

function sanctumCult(): CultInput {
  return folderCult({ name: 'Sanctum Choir', scope: 'sanctum', folderPath: null })
}

/** The chat's PTY: the one started with the chat's own OMP session folder. */
function ptyOf(chat: ChatRecord): FakePty {
  const { sessionDir } = ompFilePaths(h.rig.userData, chat.id)
  const pty = h.rig.host.spawns.find((candidate) => (candidate.spec.args as string[]).includes(sessionDir))
  if (pty === undefined) throw new Error(`No PTY was spawned for ${chat.id}.`)
  return pty
}

async function grantsIn(folder: string) {
  return h.pool.get(folder).listGrants()
}

function instructionsOf(chat: ChatRecord): string {
  return readFileSync(terminalFilePaths(h.rig.userData, chat.id, 'darwin').instructions, 'utf8')
}

describe('cult launcher: a folder cult run', () => {
  it('starts the Magos in the folder with an orchestrator grant without Allow save, the charter first and its model', async () => {
    const cult = h.cults.createCult(folderCult())
    const { run, magos } = await h.launcher.launch(cult.id)

    expect(run.state).toBe('running')
    expect(magos.start.state).toBe('running')
    expect(magos.chat).toMatchObject({ folder: h.rig.repo, agent: 'omp', role: 'orchestrator', allowSave: false, title: 'Magos Ferrum', model: MAGOS_MODEL, firstPrompt: CHARTER, cultRunId: run.id, cultRole: 'magos' })
    const args = ptyOf(magos.chat).spec.args as string[]
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', MAGOS_MODEL])
    expect(args.at(-1)).toBe(CHARTER)
    expect(ptyOf(magos.chat).spec.cwd).toBe(h.rig.repo)
    const [grant] = (await grantsIn(h.rig.repo)).filter((candidate) => h.rig.store.getChat(magos.chat)?.grantIds?.includes(candidate.id))
    expect(grant).toMatchObject({ role: 'orchestrator', allowSave: false, active: true })
    expect(h.rig.store.getChat(magos.chat)?.endpointId).toEqual(expect.any(String))
    expect(instructionsOf(magos.chat)).toContain('## Cult rules: Magos')
    expect(instructionsOf(magos.chat)).toContain('You are "Magos Ferrum"')
    expect(instructionsOf(magos.chat)).not.toContain(CHARTER)
    expect(h.cults.listMembers(run.id)).toEqual([expect.objectContaining({ chatId: magos.chat.id, role: 'magos', displayName: 'Magos Ferrum', model: MAGOS_MODEL })])
  })

  it('starts an acolyte with a worker grant, its mission first, the cheapest model by default, as a member of the run', async () => {
    const cult = h.cults.createCult(folderCult())
    const { run } = await h.launcher.launch(cult.id)
    const acolyte = await h.launcher.startAcolyte(run, { name: 'Acolyte Tests', mission: 'Write the parser tests.' })

    expect(acolyte.start.state).toBe('running')
    expect(acolyte.chat).toMatchObject({ role: 'worker', allowSave: false, title: 'Acolyte Tests', model: CHEAPEST, firstPrompt: 'Write the parser tests.', cultRunId: run.id, cultRole: 'acolyte' })
    const args = ptyOf(acolyte.chat).spec.args as string[]
    expect(args).toContain(CHEAPEST)
    expect(args.at(-1)).toBe('Write the parser tests.')
    const grant = (await grantsIn(h.rig.repo)).find((candidate) => h.rig.store.getChat(acolyte.chat)?.grantIds?.includes(candidate.id))
    expect(grant).toMatchObject({ role: 'worker', allowSave: false, active: true })
    expect(instructionsOf(acolyte.chat)).toContain('You are "Acolyte Tests", an acolyte of the cult "Order of the Cog". Your Magos is "Magos Ferrum".')
    expect(h.cults.listMembers(run.id).map((member) => [member.displayName, member.role, member.mission, member.model])).toEqual([
      ['Magos Ferrum', 'magos', '', MAGOS_MODEL],
      ['Acolyte Tests', 'acolyte', 'Write the parser tests.', CHEAPEST]
    ])
  })

  it('names an unnamed acolyte, and refuses a model id that cannot go on a command line', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const named = await h.launcher.startAcolyte(run, { mission: 'Sweep the nave.' })

    expect(named.member.displayName).toMatch(/^Acolyte /)
    expect(named.chat.title).toBe(named.member.displayName)
    await expect(h.launcher.startAcolyte(run, { mission: 'x', model: '--dangerous' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('cult launcher: member chats stay out of folder chat lists', () => {
  it('lists the folder ordinary chats only, in the folder list and in every-chat listing', async () => {
    const ordinary = h.rig.newChat('omp', 'Ordinary chat')
    const { magos } = await h.launcher.launch(h.cults.createCult(folderCult()).id)

    const listed = await h.handlers.list(h.rig.repo)
    const all = await h.handlers.listAll()
    expect(listed.ok && listed.data.map((chat) => chat.id)).toEqual([ordinary.id])
    expect(all.ok && all.data.map((chat) => chat.id)).toEqual([ordinary.id])
    expect(h.rig.store.listChats(h.rig.repo).map((chat) => chat.id)).toContain(magos.chat.id)
  })

  it('loads a legacy chat record with no cult fields, and lists it', async () => {
    const legacy = { id: 'chat_legacy', folder: h.rig.repo, agent: 'claude', model: null, role: 'worker', allowSave: false, title: 'Old', createdAt: 'a', updatedAt: 'b', sessionId: null }
    const parsed = chatRecordSchema.parse(legacy)

    expect(parsed.cultRunId).toBeUndefined()
    expect(parsed.cultRole).toBeUndefined()
    const stored = h.rig.store.createChat({ folder: h.rig.repo, agent: 'claude', model: null, role: 'worker', allowSave: false, title: 'Old' })
    expect(Object.keys(h.rig.reopenedStore().getChat(stored)!)).not.toContain('cultRunId')
    const listed = await h.handlers.list(h.rig.repo)
    expect(listed.ok && listed.data.map((chat) => chat.id)).toEqual([stored.id])
  })
})

describe('cult launcher: a sanctum run', () => {
  it('creates and registers a db-mode sanctum on a non-Git folder and starts the Magos in it', async () => {
    const cult = h.cults.createCult(sanctumCult())
    const { run, magos } = await h.launcher.launch(cult.id)
    const sanctum = join(realpathSync.native(h.rig.userData), 'cults', cult.id)

    expect(run.workDir).toBe(sanctum)
    expect(h.sanctums.resolve(sanctum)).toBe(sanctum)
    expect(JSON.parse(readFileSync(join(h.rig.userData, 'cults', 'sanctums.json'), 'utf8')).sanctums).toEqual([cult.id])
    expect(existsSync(join(sanctum, '.git'))).toBe(false)
    expect(readdirSync(sanctum)).toEqual([])
    expect(existsSync(join(dbProjectDir(sanctum, h.dmHome), 'project.json'))).toBe(true)
    expect(magos.start.state).toBe('running')
    expect(ptyOf(magos.chat).spec.cwd).toBe(sanctum)
    expect((await grantsIn(sanctum)).find((grant) => h.rig.store.getChat(magos.chat)?.grantIds?.includes(grant.id))).toMatchObject({ role: 'orchestrator', allowSave: false })
    expect(h.gates.list().map((folder) => folder.path)).toEqual([h.rig.repo])
  })

  it('ends the run, then deleting the cult removes its member chats, grants, sanctum and database project', async () => {
    const cult = h.cults.createCult(sanctumCult())
    const { run, magos } = await h.launcher.launch(cult.id)
    const acolyte = await h.launcher.startAcolyte(run, { name: 'Acolyte Psalm', mission: 'Sing.' })
    const sanctum = run.workDir
    await expect(h.launcher.deleteCult(cult.id)).rejects.toMatchObject({ code: 'active_run_exists' })

    h.cults.transitionRun(run.id, { type: 'shutdown', reason: 'stopped' })
    h.cults.transitionRun(run.id, { type: 'finish' })
    const grantIds = [magos.chat, acolyte.chat].flatMap((chat) => h.rig.store.getChat(chat)?.grantIds ?? [])
    expect(grantIds).toHaveLength(2)
    await h.launcher.deleteCult(cult.id)

    expect(h.rig.store.getChat(magos.chat)).toBeNull()
    expect(h.rig.store.getChat(acolyte.chat)).toBeNull()
    expect(h.rig.revoked).toEqual(expect.arrayContaining(grantIds))
    // Their trees were killed (a fake PTY only records it), and the sanctum's database went with the cult, grants and all.
    expect([ptyOf(magos.chat).kills, ptyOf(acolyte.chat).kills]).toEqual([1, 1])
    expect(existsSync(sanctum)).toBe(false)
    expect(existsSync(dbProjectDir(sanctum, h.dmHome))).toBe(false)
    expect(h.sanctums.resolve(sanctum)).toBeNull()
    expect(h.cults.getCult(cult.id)).toBeNull()
  })
})

describe('cult launcher: only a registered sanctum passes the untracked-folder checks', () => {
  it('refuses an arbitrary untracked path, an unregistered folder under the sanctum root and a removed sanctum', async () => {
    const stranger = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-untracked-')))
    const squatter = join(realpathSync.native(h.rig.userData), 'cults', 'ct_00000000000000000000000000')
    mkdirSync(squatter, { recursive: true })
    const sanctum = await h.sanctums.create('ct_11111111111111111111111111')
    try {
      for (const path of [stranger, squatter]) {
        expect(h.gates.resolve(path)).toBeNull()
        await expect(h.handlers.list(path)).resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
        expect(() => resolveLaunchFolder({ folder: path }, { trackedFolder: (p) => h.gates.resolve(p) })).toThrow(/is no longer tracked/)
      }
      expect(h.gates.resolve(sanctum)).toBe(sanctum)
      await h.sanctums.remove('ct_11111111111111111111111111')
      expect(h.gates.resolve(sanctum)).toBeNull()
      expect(() => h.sanctums.pathOf('../escape')).toThrow(/is not a cult id/)
    } finally {
      removeScratch(stranger)
    }
  })

  it('refuses a folder cult whose folder is no longer tracked, starting nothing', async () => {
    const cult = h.cults.createCult(folderCult())
    h.rig.tracked.delete(h.rig.repo)

    await expect(h.launcher.launch(cult.id)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(h.rig.host.spawns).toHaveLength(0)
    expect(h.cults.listRuns(cult.id)).toEqual([])
  })
})

describe('cult launcher: Plan Forge prompts', () => {
  it('gives the Magos and a specialist the same target, a stable worker type, its contract and the authority boundary', async () => {
    const epic = await h.pool.get(h.rig.repo).createEpic({ title: 'Target plan' })
    const cult = h.cults.createCult(folderCult({ archetype: 'plan_forge', targetEpicId: epic.id }))
    const { run, magos } = await h.launcher.launch(cult.id)
    const specialist = await h.launcher.startAcolyte(run, { name: 'Acolyte Ward', mission: 'Review the authority model.', slotId: 'security' })
    const target = `Target epic: ${epic.id} (none saved yet;`

    expect(instructionsOf(magos.chat)).toContain(target)
    expect(instructionsOf(magos.chat)).toContain('Summon exactly one acolyte per mandatory type')
    expect(instructionsOf(specialist.chat)).toContain(target)
    expect(instructionsOf(specialist.chat)).toContain('Worker type: Security (security), roster slot security.')
    expect(instructionsOf(specialist.chat)).toContain('The target is read-only to you')
    expect(specialist.chat.firstPrompt).toContain('Review the authority model.')
    expect(specialist.chat.firstPrompt).toContain('Contract (inert data):')
    expect(specialist.member).toMatchObject({ slotId: 'security', workerType: 'security' })
  })

  it('starts an acolyte of a Magos-created worker type with its stored contract, and keeps ordinary missions free-form', async () => {
    const { run, magos } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const type = h.cults.createWorkerType(run.id, magos.chat.id, { displayName: 'Localization', description: 'Copy.', mission: 'Check every string is translatable.', rationale: 'No one reads copy across locales.', requiredForConclusion: false })
    const typed = await h.launcher.startAcolyte(run, { name: 'Acolyte Lingua', mission: 'Audit the strings.', runWorkerTypeId: type.id })
    const plain = await h.launcher.startAcolyte(run, { name: 'Acolyte Plain', mission: 'Sweep the nave.' })

    expect(typed.chat.firstPrompt).toContain(`Contract (inert data): ${JSON.stringify(type.mission)}`)
    expect(instructionsOf(typed.chat)).toContain('Optional for conclusion')
    expect(plain.chat.firstPrompt).toBe('Sweep the nave.')
  })
})

describe('cult launcher: ending a member', () => {
  it('gives a graceful member Ctrl+D and lets it exit on its own, revoking its grant', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const acolyte = await h.launcher.startAcolyte(run, { name: 'Acolyte Exit', mission: 'Leave.' })
    const pty = ptyOf(acolyte.chat)
    const ending = h.launcher.endMember(acolyte.chat.id, { graceful: true })
    await settle()

    expect(pty.written).toContain('\x04')
    pty.exit()
    await ending
    await settle()
    expect(pty.kills).toBe(0)
    const grantId = h.rig.store.getChat(acolyte.chat)!.grantIds![0]!
    expect((await grantsIn(h.rig.repo)).find((grant) => grant.id === grantId)?.active).toBe(false)
  })

  it('kills a member that does not exit within the graceful window, and at once without it', async () => {
    const { run } = await h.launcher.launch(h.cults.createCult(folderCult()).id)
    const stubborn = await h.launcher.startAcolyte(run, { name: 'Acolyte Stubborn', mission: 'Stay.' })
    const ending = h.launcher.endMember(stubborn.chat.id, { graceful: true })
    await settle()
    h.rig.clock.advance(GRACEFUL_EXIT_MS)
    await ending

    expect(ptyOf(stubborn.chat).kills).toBe(1)
    const abrupt = await h.launcher.startAcolyte(run, { name: 'Acolyte Abrupt', mission: 'Stay.' })
    await h.launcher.endMember(abrupt.chat.id, { graceful: false })
    expect(ptyOf(abrupt.chat).written).not.toContain('\x04')
    expect(ptyOf(abrupt.chat).kills).toBe(1)
  })
})
