/**
 * Cult runs over the real pieces, for the launcher's and the supervisor's tests: desktop workspaces (a sanctum's in db
 * mode, on a folder that is not a Git repository, through the real Git adapter), real chat grants with mailbox binding,
 * the cult store on a real app database, the sanctum registry and the members' control files on disk, and the terminal
 * session manager on the fake PTY host (`terminalSessionsRig`). Not shipped.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError } from '../../../core/errors'
import { openWorkspace } from '../../../core/workspace'
import type { CultInput } from '../../../shared/cults/cult'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { removeScratch } from '../../../test/removeScratch'
import { createSequentialIds, createTestClock } from '../../../test/testContext'
import { TEST_STORAGE } from '../../../test/workspaceHarness'
import { builtInAgent, connectedAgents } from '../../agents/__mocks__/chatFixtures'
import { createChatGrants, type ChatGrants } from '../../agents/chatGrants'
import { createChatHandlers, type ChatHandlers } from '../../agents/chatHandlers'
import { createChatRecords, type ChatRecords } from '../../agents/chatRecords'
import { createTestWorkspacePool, type TestWorkspacePool } from '../../desktop/__mocks__/projectWorkspaceFixture'
import { openAppDatabase } from '../../desktop/appDatabase'
import type { FakePty } from '../../terminals/__mocks__/fakePtyHost'
import { cliFor, terminalRig, type TerminalRig } from '../../terminals/__mocks__/terminalSessionsRig'
import { ompFilePaths, removeOmpFolder } from '../../terminals/ompSession'
import { endingTerminals } from '../../terminals/terminalSessions'
import { createCultControl, type CultControl } from '../cultControl'
import { createCultLauncher, type CultLauncher } from '../cultLauncher'
import { createCultStore, type CultStore } from '../cultStore'
import { cheapest, parseOmpModels } from '../ompModels'
import { createSanctumRegistry, withSanctums, type SanctumRegistry } from '../sanctumRegistry'
import { createPlanForgeCouncil, type PlanForgeCouncil } from '../planForgeCouncil'

const MODELS = readFileSync(new URL('../__fixtures__/omp-models.json', import.meta.url), 'utf8')
export const CHEAPEST = cheapest(parseOmpModels(MODELS, ['anthropic']) ?? [])!.id
export const MAGOS_MODEL = 'anthropic/claude-opus-4-5'
export const CHARTER = 'Polish the brass reliquary until it reflects the Omnissiah.'

export interface CultHarness {
  rig: TerminalRig
  pool: TestWorkspacePool
  cults: CultStore
  sanctums: SanctumRegistry
  gates: { resolve(path: string): string | null; list(): TrackedFolderView[] }
  records: ChatRecords
  grants: ChatGrants
  control: CultControl
  launcher: CultLauncher
  handlers: ChatHandlers
  dmHome: string
  /** The Plan Forge council over the rig's store and workspaces; every launch binds a Plan Forge run through it. */
  council: PlanForgeCouncil
}

export interface CultHarnessOptions {
  /** The cult store's clock; the store's own by default. */
  now?: () => string
  /** A killed fake PTY exits, as `killPtyTree` ends a real tree; by default a fake PTY only counts the kill. */
  exitOnKill?: boolean
}

function workspacePool(root: string, dmHome: string): TestWorkspacePool {
  const clock = createTestClock('2026-11-26T09:00:00.000Z')
  const ids = createSequentialIds()
  // No fake Git: the sanctum is a plain folder, and the real adapter must cope with that.
  return createTestWorkspacePool((repoRoot) =>
    openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir: dmHome, clock, ids, ...TEST_STORAGE })
  , root)
}

/** The same gates main has: tracked folders (the rig's), then registered sanctums. */
function gatesOf(rig: TerminalRig, sanctums: SanctumRegistry): CultHarness['gates'] {
  const folders = {
    resolve: (path: string) => (rig.tracked.has(path) ? path : null),
    list: () => [...rig.tracked].map((path) => ({ path }) as TrackedFolderView)
  }
  return withSanctums(folders, sanctums)
}

function grantsOver(gates: CultHarness['gates'], pool: TestWorkspacePool): ChatGrants {
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

function handlersOver(gates: CultHarness['gates'], records: ChatRecords): ChatHandlers {
  const unused = {} as never
  return createChatHandlers({ registry: gates, agents: { get: () => builtInAgent('omp') }, chats: records, terminals: unused, agentChats: unused, plannerAgents: unused, runs: unused, transfers: unused, kanban: unused })
}

/** Makes every PTY the rig spawns exit once killed. */
function exitingOnKill(rig: TerminalRig): void {
  rig.host.onSpawn = (pty) => {
    const kill = pty.kill.bind(pty)
    pty.kill = () => {
      kill()
      queueMicrotask(() => {
        if (!pty.exited) pty.exit({ exitCode: 137, signal: 9 })
      })
    }
  }
}

function rigOver(late: { gates: CultHarness['gates'] | null; grants: ChatGrants | null }): TerminalRig {
  const rig = terminalRig({
    agents: [builtInAgent('omp')],
    killSettlesAtOnce: true,
    deps: () => ({
      folders: { trackedFolder: (path) => late.gates!.resolve(path) },
      issueChatCli: (folder, grant, chat) => late.grants!.issueChatCli(folder, grant, chat),
      // As main's terminals do: each launch binds its grant to the chat and its generation, for the control pipe.
      bindChatGrant: (grantId, identity) => late.grants!.bindChatGrant(grantId, identity),
      revokeChatGrant: async (grantId) => {
        rig.revoked.push(grantId)
        await late.grants!.revokeChatGrant(grantId)
      },
      renewChatGrant: async (grantId) => {
        rig.renewed.push(grantId)
        await late.grants!.renewChatGrant(grantId)
      }
    })
  })
  return rig
}

export async function cultHarness(options: CultHarnessOptions = {}): Promise<CultHarness> {
  const late: { gates: CultHarness['gates'] | null; grants: ChatGrants | null } = { gates: null, grants: null }
  const rig = rigOver(late)
  if (options.exitOnKill === true) exitingOnKill(rig)
  const dmHome = join(rig.root, 'dm-home')
  const pool = workspacePool(rig.root, dmHome)
  await pool.get(rig.repo).initializeRepository({ name: 'repo', mode: 'db' })
  const sanctums = createSanctumRegistry({ userData: rig.userData })
  const gates = (late.gates = gatesOf(rig, sanctums))
  const grants = (late.grants = grantsOver(gates, pool))
  const records = endingTerminals(
    createChatRecords({ store: rig.store, agentFor: connectedAgents([builtInAgent('omp')]), removeOmpFolder: (id) => removeOmpFolder(rig.userData, id) }),
    rig.sessions
  )
  const cults = createCultStore({ db: openAppDatabase(mkdtempSync(join(rig.root, 'app-'))), ...(options.now === undefined ? {} : { now: options.now }) })
  const control = createCultControl({ userData: rig.userData, epochOf: (chatId) => rig.sessions.generationOf(chatId) })
  const workspaceFor = (folder: string) => {
    if (gates.resolve(folder) !== folder) throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
    return pool.get(folder)
  }
  const council = createPlanForgeCouncil({ cults, workspaceFor, grantIdsOf: (run, chatId) => rig.store.getChat({ folder: run.workDir, id: chatId })?.grantIds ?? [] })
  const launcher = createCultLauncher({
    cults, folders: { resolve: (path) => (rig.tracked.has(path) ? path : null) }, sanctums, chats: records, terminals: rig.sessions, control,
    workspaceFor: (folder) => {
      const workspace = workspaceFor(folder)
      // The chat store keeps chats only in folders it can find; a sanctum is one from now on.
      rig.chatFs.folders.add(folder)
      return workspace
    },
    closeWorkspace: (folder) => pool.close(folder),
    cheapestModel: async () => CHEAPEST,
    userData: rig.userData,
    dmHome,
    bindTarget: (run) => council.bind(run)
  })
  return { rig, pool, cults, sanctums, gates, records, grants, control, launcher, handlers: handlersOver(gates, records), dmHome, council }
}

/** Quits the terminals (every fake PTY told to exit), closes the workspaces and removes the scratch folder. */
export async function disposeCultHarness(h: CultHarness): Promise<void> {
  const disposing = h.rig.sessions.dispose()
  for (const pty of h.rig.host.spawns) if (!pty.exited) pty.exit({ exitCode: 0, signal: null })
  await disposing
  await h.pool.closeAll()
  removeScratch(h.rig.root)
}

export function folderCultInput(h: CultHarness, overrides: Partial<CultInput> = {}): CultInput {
  return {
    name: 'Order of the Cog', charter: CHARTER, scope: 'folder', folderPath: h.rig.repo, archetype: 'general',
    magosName: 'Magos Ferrum', magosModelId: MAGOS_MODEL, defaultTimeLimitMs: 60 * 60_000, ...overrides
  }
}

/** The chat's PTY (a chat record's, or a member's): the one started with the chat's own OMP session folder. */
export function ptyOf(h: CultHarness, chat: { id: string } | { chatId: string }): FakePty {
  const chatId = 'chatId' in chat ? chat.chatId : chat.id
  const { sessionDir } = ompFilePaths(h.rig.userData, chatId)
  const pty = h.rig.host.spawns.find((candidate) => (candidate.spec.args as string[]).includes(sessionDir))
  if (pty === undefined) throw new Error(`No PTY was spawned for ${chatId}.`)
  return pty
}
