/**
 * Two repositories on one throwaway machine, for the SPACE loop end-to-end tests (DM-193, `src/integration/space*.test.ts`)
 * and the real-app evidence seed (`docs/verification/DM-193/seed.ts`). Everything lives under one root: a unique folder
 * in the system temp folder, or the root the seed names. Not shipped.
 *
 * - `userData` (`folders.json`, `source-checkout.json`), the Dark Mechanicus home and a home directory, with the real
 *   folder registry, source checkout store, workspace pool, desktop `dm:command` handlers and cross-repository
 *   correction broker main registers over them.
 * - `project`: a real Git repository (`main` with one commit), tracked and set up as its own Dark Mechanicus project.
 * - `dm`: a controlled Dark Mechanicus source checkout, tracked and set up as another project: by default a fresh
 *   Git repository holding the source marker files; the seed passes `dmCheckout` to use a real clone instead.
 *
 * Each side opens real workspaces (repository storage on disk, the real Git adapter) with its own test clock and id
 * range, so two projects never mint the same id and the same steps give the same records. A run binds the branch its
 * repository has checked out, and each sprint's acceptance node names a real squashed commit on it (`land`). `faults.link`
 * makes the source's next link writes fail like an I/O error, the one fault a real run cannot produce on demand.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ctx } from '../core/context'
import { encodeBase32, ID_PREFIXES, type IdGenerator } from '../core/ids'
import { openWorkspace, type Workspace } from '../core/workspace'
import { createCrossRepoCorrectionHandlers, type CrossRepoCorrectionHandlers } from '../main/desktop/crossRepoCorrections'
import { createFolderRegistry, type FolderRegistry } from '../main/desktop/folderRegistry'
import { createSourceCheckouts, type SourceCheckouts } from '../main/desktop/sourceCheckout'
import { createWorkspacePool, type WorkspacePool } from '../main/desktop/workspacePool'
import { createMcpServer } from '../mcp/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SessionRole } from '../shared/domain/views'
import { createGitAdapter } from '../core/repo/git'
import { markerCheckout } from './crossRepoWorld'
import { createGitRepo, type GitRepo } from './gitRepo'
import { removeScratch } from './removeScratch'
import { type Bridge, bridgeOver } from './scoreWorld'
import { createTestClock, type TestClock } from './testContext'
import { TEST_STORAGE } from './workspaceHarness'

/** The source project's clock starts here; the Dark Mechanicus checkout's a day later (`DM_T0`). */
const PROJECT_T0 = '2026-11-15T09:00:00.000Z'
const DM_T0 = '2026-11-16T06:00:00.000Z'
const MCP_INFO = { name: 'darkmechanicus', version: '0.0.0-dm193' }

/** Sequential ids from `start` on: two sides given distant starts never mint the same id. */
function idsFrom(start: number): IdGenerator {
  let counter = start
  return {
    next(kind) {
      counter += 1
      return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(counter), 26)}`
    },
    secret() {
      counter += 1
      return `secret-${counter}`
    }
  }
}

export interface Side {
  name: string
  path: string
  /** The repository itself: branch, commit and read history the way a person or a worker does. */
  repo: GitRepo
  clock: TestClock
  /** The person's session the desktop opens for this folder (the pool's, which the broker and `dm:command` use). */
  desktop: Workspace
  /** An orchestrator session allowed to save, as a person connects one. */
  orchestrator: Workspace
  /** Opens another session on this folder with the side's clock and ids. */
  open(role: SessionRole): Workspace
}

interface Faults {
  /** While above 0, each source link write fails like an I/O error and counts down. */
  link: number
}

export interface TwoRepoMachine {
  root: string
  userData: string
  dmHome: string
  home: string
  registry: FolderRegistry
  checkouts: SourceCheckouts
  pool: WorkspacePool
  broker: CrossRepoCorrectionHandlers
  /** `dm:command` as main registers it, over this machine's registry and pool. */
  bridge: Bridge
  faults: Faults
  /** Errors the broker reported as unexpected (not DomainErrors). */
  unexpected: string[]
  project: Side
  dm: Side
  /** Opens a session on any folder (a copy, a clone) with its own fresh clock and ids. */
  openAt(path: string, role: SessionRole, at?: string): Workspace
  /** An MCP server over a session of `side`, as `darkmechanicus-mcp --role <role>` serves it. */
  mcp(side: Side, role: SessionRole): McpServer
  /** Makes the Dark Mechanicus checkout this machine's chosen one (DM-189's association). */
  chooseCheckout(): void
  close(): void
  /** Closes every session and removes the root (only when this machine made it). */
  cleanup(): void
}

interface MachineOptions {
  /** Use this folder as the root (the seed's); default: a new unique temp folder, removed by `cleanup`. */
  root?: string
  /** Builds the Dark Mechanicus checkout at `dest` (a folder not yet there); default: the markers in a fresh repository. */
  dmCheckout?: (dest: string) => GitRepo
  projectName?: string
}

/** The source marker files of a Dark Mechanicus checkout in a fresh repository (no project record yet). */
function markerRepository(dest: string): GitRepo {
  const repo = createGitRepo({ root: dest })
  markerCheckout(dest, { git: false, projectId: null })
  return repo
}

/** A workspace whose database fails the source's link writes while `faults.link` says so. */
function faulty(workspace: Workspace, faults: Faults): Workspace {
  return new Proxy(workspace, {
    get(target, property, receiver) {
      if (property !== 'ctx') return Reflect.get(target, property, receiver) as unknown
      return (): Ctx => {
        const ctx = target.ctx()
        const db = new Proxy(ctx.db, {
          get(dbTarget, dbProperty) {
            const value = Reflect.get(dbTarget, dbProperty) as unknown
            if (dbProperty !== 'run') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(dbTarget) : value
            return (sql: string, ...params: unknown[]) => {
              if (faults.link > 0 && sql.includes("SET state = 'linked'")) {
                faults.link -= 1
                throw new Error('SQLITE_IOERR: disk I/O error (injected by the DM-193 machine)')
              }
              return dbTarget.run(sql, ...(params as never[]))
            }
          }
        })
        return { ...ctx, db }
      }
    }
  })
}

interface Sessions {
  /** Opens a session on `path` with that folder's clock and ids (made at `at` on first use). */
  openAt(path: string, role: SessionRole, at?: string): Workspace
  clockOf(path: string, at: string): TestClock
  closeAll(): void
}

/** Real workspaces on real folders: one test clock and id range per folder, every session closed by `closeAll`. */
function sessions(dmHome: string): Sessions {
  const opened: Workspace[] = []
  const configs = new Map<string, { clock: TestClock; ids: IdGenerator }>()
  const configOf = (path: string, at = PROJECT_T0) => {
    const config = configs.get(path) ?? { clock: createTestClock(at), ids: idsFrom((configs.size + 2) * 1_000_000) }
    configs.set(path, config)
    return config
  }
  return {
    openAt: (path, role, at) => {
      const { clock, ids } = configOf(path, at)
      const workspace = openWorkspace({
        repoRoot: path,
        role,
        label: `${role} session (DM-193)`,
        transport: role === 'desktop' ? 'desktop' : 'in_process',
        allowSave: true,
        homeDir: dmHome,
        clock,
        ids,
        git: createGitAdapter(path),
        ...TEST_STORAGE,
        autoReconcile: false,
        serverInfo: MCP_INFO
      })
      opened.push(workspace)
      return workspace
    },
    clockOf: (path, at) => configOf(path, at).clock,
    closeAll: () => {
      for (const workspace of opened.splice(0)) workspace.close()
    }
  }
}

/** Tracks `repo` as a folder of this machine and gives it its own clock, the pool's desktop session and an orchestrator. */
function trackSide(env: { registry: FolderRegistry; pool: WorkspacePool; open: Sessions }, name: string, repo: GitRepo, at: string): Side {
  const { registry, pool, open } = env
  const tracked = registry.track(realpathSync.native(repo.root)).folder.path
  return {
    name,
    path: tracked,
    repo,
    clock: open.clockOf(tracked, at),
    // The pool's session, reopened after `pool.close` (a restart) the way the desktop reopens a folder.
    get desktop() {
      return pool.get(tracked)
    },
    orchestrator: open.openAt(tracked, 'orchestrator'),
    open: (role) => open.openAt(tracked, role)
  }
}

export function twoRepoMachine(options: MachineOptions = {}): TwoRepoMachine {
  const made = options.root === undefined
  const root = realpathSync.native(options.root ?? mkdtempSync(join(tmpdir(), 'dm193-')))
  const [userData, dmHome, home] = [join(root, 'userData'), join(root, 'dm-home'), join(root, 'home')]
  mkdirSync(home, { recursive: true })
  const registry = createFolderRegistry({ file: join(userData, 'folders.json'), homeDir: home, dmHome, now: () => PROJECT_T0 })
  const checkouts = createSourceCheckouts({ file: join(userData, 'source-checkout.json'), homeDir: home, dmHome, registry, installedAppDirs: () => [], now: () => PROJECT_T0 })
  const faults: Faults = { link: 0 }
  const open = sessions(dmHome)
  const pool = createWorkspacePool((path) => faulty(open.openAt(path, 'desktop'), faults))
  const unexpected: string[] = []
  const env = { registry, pool, open }
  const projectName = options.projectName ?? 'shop'
  const project = trackSide(env, projectName, createGitRepo({ root: join(root, projectName) }), PROJECT_T0)
  const dm = trackSide(env, 'dm-checkout', (options.dmCheckout ?? markerRepository)(join(root, 'dm-checkout')), DM_T0)
  const close = () => {
    pool.closeAll()
    open.closeAll()
  }
  return {
    root,
    userData,
    dmHome,
    home,
    registry,
    checkouts,
    pool,
    broker: createCrossRepoCorrectionHandlers({ registry, pool, checkouts, onUnexpectedError: (error) => unexpected.push(String(error)) }),
    bridge: bridgeOver(registry, pool),
    faults,
    unexpected,
    project,
    dm,
    openAt: open.openAt,
    mcp: (of, role) => createMcpServer(of.open(role), MCP_INFO, { role, allowSave: role === 'orchestrator' || role === 'planner' }),
    chooseCheckout: () => {
      const choice = checkouts.associate(dm.path, false)
      if (choice.outcome !== 'associated') throw new Error(`could not choose ${dm.path}: ${JSON.stringify(choice)}`)
    },
    close,
    cleanup: () => {
      close()
      if (made) removeScratch(root)
    }
  }
}
