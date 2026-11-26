/** Synchronous SQLite fixtures through the production queue and operation allow-list. */
import type { Workspace } from '../../../core/workspace'
import { currentForgeTransfer, withForgeOwnerAuthority } from '../../../core/repo/forgeBinding'
import { hasValidatedRepositoryCache } from '../../../core/repo/validatedCache'
import type { OwnerTransport, ProjectWorkspace, SyncValue, Work } from '../workspaceClient'
import { workspaceClient } from '../workspaceClient'
import { runWorkspaceOperation } from '../workspaceOperations'
import { createWorkspacePool, type WorkspacePool } from '../workspacePool'

export type TestWorkspace = ProjectWorkspace & Workspace
export type TestWorkspacePool = Omit<WorkspacePool, 'get'> & { get(path: string): TestWorkspace }

export function testWorkspace(workspace: Workspace, home = ''): TestWorkspace {
  const client = workspaceClient(workspace.repoRoot, () => true, work => runWorkspaceOperation(workspace, work, home))
  return Object.assign({}, workspace, client)
}

/** Member readiness work opens a store without its open-time import, as the production owner does: its lane imports it. */
function defersOpenReconcile(work: Work): boolean {
  return work.kind === 'native' && work.name === 'hasValidatedCache'
}

/** One owner over the shared stores. These workspaces reconcile on their own open and heartbeat; a member or explicit reconcile runs as the command. */
function fixtureTransport(stores: Map<string, Workspace>, store: (path: string, deferOpenReconcile?: boolean) => Workspace, home: string): OwnerTransport {
  let path: string | undefined
  return {
    async run(repo, work, authority) {
      path = repo
      return { value: await withForgeOwnerAuthority({ home, ownerPid: process.pid, path: repo, authority }, () => runWorkspaceOperation(store(repo, defersOpenReconcile(work)), work, home)), binding: repo }
    },
    async sync(repo, mode, authority) {
      path = repo
      const value = await withForgeOwnerAuthority({ home, ownerPid: process.pid, path: repo, authority }, async (): Promise<SyncValue> => {
        if (mode === 'heartbeat') return { result: null, hasLocalCache: false }
        // A member reconcile is the store's import, so a store it opens skips its open-time import.
        const workspace = store(repo, mode === 'member')
        const hasLocalCache = hasValidatedRepositoryCache(workspace.ctx().db)
        return { result: await workspace.reconcileRepository(), hasLocalCache }
      })
      return { value, binding: repo }
    },
    async close() {
      if (path === undefined) return
      stores.get(path)?.close()
      stores.delete(path)
    }
  }
}

/** `open` receives whether the production owner would defer its open-time import for the first work it runs. */
export function createTestWorkspacePool(open: (path: string, deferOpenReconcile: boolean) => Workspace, home = ''): TestWorkspacePool {
  const stores = new Map<string, Workspace>()
  function store(path: string, deferOpenReconcile = false): Workspace {
    const known = stores.get(path)
    if (known) return known
    const workspace = open(path, deferOpenReconcile)
    stores.set(path, workspace)
    return workspace
  }
  const pool = createWorkspacePool({ open: () => fixtureTransport(stores, store, home), canonical: path => path, authority: currentForgeTransfer })
  const clients = new WeakMap<ProjectWorkspace, TestWorkspace>()
  function probe(client: ProjectWorkspace): TestWorkspace {
    const previous = clients.get(client)
    if (previous !== undefined) return previous
    const wrapped = new Proxy(client as TestWorkspace, {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver)
        return Reflect.get(store(client.repoRoot), property)
      }
    })
    clients.set(client, wrapped)
    return wrapped
  }
  return { ...pool, get: path => probe(pool.get(path)), background: path => pool.background(path), reconcile: path => pool.reconcile(path), heartbeatAll: () => pool.heartbeatAll(),
    close: async path => {
      await pool.close(path)
      stores.get(path)?.close()
      stores.delete(path)
    }, closeAll: async () => {
      await pool.closeAll()
      for (const workspace of stores.values()) workspace.close()
      stores.clear()
    } }
}
