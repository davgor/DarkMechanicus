import { join } from 'node:path'
import { API_VERSION } from '../../shared/domain/api'
import type { CapabilitiesView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { SCHEMA_VERSION } from '../db/migrations'
import { fail } from '../errors'
import { backupDatabase } from '../repo/backup'
import { listBranchEpics } from '../repo/branchEpics'
import { getStorageStatus } from '../repo/storage'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { listEvents } from '../services/events'
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

export const repositoryCommands = {
  getCapabilities: {
    mutates: false,
    beforeInit: true,
    run: (core) => capabilitiesView(core)
  },
  getProject: {
    mutates: false,
    run: (core) => {
      const project = core.project()
      return {
        projectId: project.projectId,
        name: project.name,
        keyPrefix: project.keyPrefix,
        repoRoot: core.repoRoot,
        createdAt: project.createdAt
      }
    }
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
