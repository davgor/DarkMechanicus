import { join } from 'node:path'
import { API_VERSION } from '../../shared/domain/api'
import type { CapabilitiesView, ProjectView, RepositoryView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { SCHEMA_VERSION } from '../db/migrations'
import { fail } from '../errors'
import { backupDatabase } from '../repo/backup'
import { listBranchEpics } from '../repo/branchEpics'
import { readProject } from '../repo/initialize'
import type { RepositoryEntry } from '../repo/portable'
import { rescanRepositories, writeDefinitionOfDone } from '../repo/projectConfig'
import { getStorageStatus } from '../repo/storage'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { resolveEpicConflict } from '../services/epicConflict'
import { appendEvent, listEvents } from '../services/events'
import { issueGrant, listGrants, renewGrant, revokeGrant } from '../services/grants'
import { searchHistory } from '../services/history'
import { listSessions } from '../services/sessions'
import { SKILLS_VERSION } from '../version'
import type { CommandTable, WorkspaceCore } from './types'

function capabilitiesView(core: WorkspaceCore): CapabilitiesView {
  return {
    server: core.options.serverInfo ?? { name: 'darkmechanicus', version: '0.0.0' },
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    skillsVersion: SKILLS_VERSION,
    role: core.role,
    sessionId: core.sessionId(),
    capabilities: core.isInitialized() ? [...core.ctx().session.capabilities] : core.roleCapabilities(),
    repoRoot: core.repoRoot,
    initialized: core.isInitialized()
  }
}

function requireRoleCapability(core: WorkspaceCore, capability: 'repo.init'): void {
  if (!core.roleCapabilities().includes(capability)) {
    fail('unauthorized', `This ${core.role} session is not permitted to perform "${capability}".`)
  }
}

function repositoryViews(entries: RepositoryEntry[]): RepositoryView[] {
  return entries.map((entry) => ({
    name: entry.name,
    missing: entry.missing === true,
    ...(entry.definitionOfDone === undefined ? {} : { definitionOfDone: entry.definitionOfDone })
  }))
}

function projectView(core: WorkspaceCore): ProjectView {
  const project = core.project()
  // Read from the file each time, like the Definition of Done, so a rescan behind an open session shows.
  const repositories = readProject(core.layout, core.fs)?.repositories
  return {
    projectId: project.projectId,
    name: project.name,
    keyPrefix: project.keyPrefix,
    repoRoot: core.repoRoot,
    createdAt: project.createdAt,
    definitionOfDone: core.ctx().definitionOfDone(),
    repositories: repositories === undefined ? null : repositoryViews(repositories)
  }
}

/** Re-detects the folder's child repositories, writes them to project.json, then records what changed. */
function rescan(core: WorkspaceCore): RepositoryView[] {
  const ctx = core.ctx()
  requireCapability(ctx.session, 'project.repositories')
  const result = rescanRepositories(core)
  ctx.db.tx(() =>
    appendEvent(ctx, {
      kind: 'project.repositories_rescanned',
      payload: { added: result.added, missing: result.missing }
    })
  )
  return repositoryViews(result.project.repositories ?? [])
}

/**
 * Writes the checks to project.json (repository `repo`'s in a folder of repositories), then records the change in
 * the event log. Nothing is committed.
 */
function setDefinitionOfDone(
  core: WorkspaceCore,
  input: { checks: Parameters<typeof writeDefinitionOfDone>[1]; repo?: string }
): ProjectView {
  const ctx = core.ctx()
  requireCapability(ctx.session, 'project.definition_of_done')
  const written = writeDefinitionOfDone(core, input.checks, input.repo)
  const list = input.repo === undefined ? written.definitionOfDone : written.repositories?.find((entry) => entry.name === input.repo)?.definitionOfDone
  const names = (list ?? []).map((check) => check.name)
  const payload = input.repo === undefined ? { names } : { repository: input.repo, names }
  ctx.db.tx(() => appendEvent(ctx, { kind: 'project.definition_of_done_set', payload }))
  return projectView(core)
}

const repositoryCommands = {
  getCapabilities: {
    mutates: false,
    beforeInit: true,
    run: (core) => capabilitiesView(core)
  },
  getProject: {
    mutates: false,
    run: (core) => projectView(core)
  },
  setDefinitionOfDone: {
    schema: COMMAND_SCHEMAS.setDefinitionOfDone,
    mutates: true,
    run: setDefinitionOfDone
  },
  rescanRepositories: {
    mutates: true,
    run: rescan
  },
  initializeRepository: {
    schema: COMMAND_SCHEMAS.initializeRepository,
    mutates: true,
    beforeInit: true,
    run: (core, input) => {
      requireRoleCapability(core, 'repo.init')
      return core.initialize(input)
    }
  },
  getStorageStatus: {
    mutates: false,
    beforeInit: true,
    run: (core) =>
      getStorageStatus({ db: core.db(), layout: core.layout, fs: core.fs, git: core.git, clock: core.clock })
  },
  flushPortableState: {
    mutates: false,
    run: (core) => {
      requireCapability(core.ctx().session, 'repo.flush')
      return core.flush()
    }
  },
  reconcileRepository: {
    mutates: true,
    run: (core) => {
      requireCapability(core.ctx().session, 'repo.reconcile')
      return core.reconcile()
    }
  },
  resolveEpicConflict: {
    schema: COMMAND_SCHEMAS.resolveEpicConflict,
    mutates: true,
    run: (core, input) => resolveEpicConflict(core.ctx(), input, core)
  },
  searchHistory: {
    schema: COMMAND_SCHEMAS.searchHistory,
    mutates: false,
    run: (core, input) => searchHistory(core.ctx(), input)
  },
  listBranchEpics: {
    mutates: false,
    run: (core) => {
      requireCapability(core.ctx().session, 'read')
      return listBranchEpics({ db: core.ctx().db, git: core.git, layout: core.layout })
    }
  },
  backupDatabase: {
    schema: COMMAND_SCHEMAS.backupDatabase,
    mutates: false,
    run: (core, input) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'repo.backup')
      const target = input.targetPath ? join(core.layout.localDir, 'backups', input.targetPath) : undefined
      return backupDatabase({ db: ctx.db, layout: core.layout, fs: core.fs, clock: core.clock }, target)
    }
  },
  listSessions: {
    mutates: false,
    run: (core) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'read')
      return listSessions({ db: ctx.db, clock: ctx.clock })
    }
  },
  issueGrant: {
    schema: COMMAND_SCHEMAS.issueGrant,
    mutates: true,
    run: (core, input) => {
      const ctx = core.ctx()
      const issued = ctx.db.tx(() => {
        const result = issueGrant(ctx, input)
        appendEvent(ctx, { kind: 'grant.issued', payload: { grantId: result.grant.id, role: result.grant.role } })
        return result
      })
      return issued
    }
  },
  listGrants: {
    mutates: false,
    run: (core) => listGrants(core.ctx())
  },
  revokeGrant: {
    schema: COMMAND_SCHEMAS.revokeGrant,
    mutates: true,
    run: (core, input) => {
      const ctx = core.ctx()
      return ctx.db.tx(() => {
        const grant = revokeGrant(ctx, input.grantId)
        appendEvent(ctx, { kind: 'grant.revoked', payload: { grantId: grant.id } })
        return grant
      })
    }
  },
  renewGrant: {
    schema: COMMAND_SCHEMAS.renewGrant,
    mutates: true,
    run: (core, input) => {
      const ctx = core.ctx()
      return ctx.db.tx(() => {
        const grant = renewGrant(ctx, input)
        appendEvent(ctx, { kind: 'grant.renewed', payload: { grantId: grant.id, expiresAt: grant.expiresAt } })
        return grant
      })
    }
  },
  listEvents: {
    schema: COMMAND_SCHEMAS.listEvents,
    mutates: false,
    run: (core, input) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'read')
      return listEvents(ctx, input)
    }
  }
} satisfies Partial<CommandTable>

export { repositoryCommands }
