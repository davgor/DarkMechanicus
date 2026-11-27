import { HUMAN_QUESTION_GUIDANCE, telegramAvailable } from '../humanQuestions'
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
import { activeContextNotices } from '../services/standardsNotifications'
import { standardizeProjectWork } from '../services/standardization'
import { policyForStore, savePolicy } from '../repo/deliveryPolicy'
import { rescanRepositories, writeDefinitionOfDone } from '../repo/projectConfig'
import { getStorageStatus } from '../repo/storage'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { agentMailboxStatus } from '../services/agentMail'
import { resolveEpicConflict } from '../services/epicConflict'
import { appendEvent, latestSeq, listEvents } from '../services/events'
import { issueGrant, listGrants, renewGrant, revokeGrant } from '../services/grants'
import { searchHistory } from '../services/history'
import { listSessions } from '../services/sessions'
import { decideSavePermission, listSavePermissionRequests, requestSavePermission } from '../services/savePermissions'
import { yoloSessionScope } from '../services/yolo'
import { SKILLS_VERSION } from '../version'
import type { CommandTable, WorkspaceCore } from './types'

/** A missing `packaged` is false: an unpackaged or unidentified build never stands for the installed app. */
function serverView(info: WorkspaceCore['options']['serverInfo']): CapabilitiesView['server'] {
  const { name, version } = info ?? { name: 'darkmechanicus', version: '0.0.0' }
  return { name, version, packaged: info?.packaged ?? false }
}

function capabilitiesView(core: WorkspaceCore): CapabilitiesView {
  const initialized = core.isInitialized()
  const yolo = initialized ? yoloSessionScope(core.ctx()) : undefined
  return {
    server: serverView(core.options.serverInfo),
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    skillsVersion: SKILLS_VERSION,
    humanQuestions: { available: telegramAvailable(core.homeDir), guidance: HUMAN_QUESTION_GUIDANCE },
    role: core.role,
    sessionId: core.sessionId(),
    capabilities: initialized ? [...core.ctx().session.capabilities] : core.roleCapabilities(),
    repoRoot: core.repoRoot,
    initialized,
    ...(yolo === undefined ? {} : { yolo }),
    // Never a promise the role alone could make: an uninitialized folder has no mailbox to be bound to.
    mailbox: initialized
      ? agentMailboxStatus(core.ctx())
      : { bound: false, reason: core.roleCapabilities().includes('mail.use') ? 'unbound' : 'no_mail_capability' }
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
  const current = readProject(core.layout, core.fs) ?? fail('not_initialized', 'The active project store is unavailable. Reopen it before editing standards.')
  const repositories = current.repositories
  const deliveryStandards = policyForStore(core.layout, core.ctx().db, current, core.fs)
  const assignedDeliveryRequirements = activeContextNotices(core.ctx())
  return {
    ...(assignedDeliveryRequirements.length && { assignedDeliveryRequirements }),
    ...(deliveryStandards && { deliveryStandards }),
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
  standardizeProjectWork: {
    schema: COMMAND_SCHEMAS.standardizeProjectWork,
    mutates: true,
    run: standardizeProjectWork
  },
  setDeliveryStandards: {
    schema: COMMAND_SCHEMAS.setDeliveryStandards,
    mutates: true,
    run: (core, input) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'project.definition_of_done')
      return ctx.db.tx(() => savePolicy(core, ctx.db, input.expectedRevision, input.policy))
    }
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
  switchStorageMode: {
    schema: COMMAND_SCHEMAS.switchStorageMode,
    mutates: true,
    run: (core, input) => {
      requireCapability(core.ctx().session, 'repo.switch_storage')
      if (core.role !== 'desktop' || core.transport !== 'desktop') {
        fail('unauthorized', 'Only a person in the desktop app may confirm a storage switch.')
      }
      return core.switchStorageMode(input.mode)
    }
  },
  getStorageStatus: {
    mutates: false,
    beforeInit: true,
    run: (core) => getStorageStatus({
      db: core.db(), layout: core.layout, fs: core.fs, git: core.git, clock: core.clock, recordStatus: core.recordStatus
    })
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
      // Supported-API restriction: the copy holds every local mailbox, so only the desktop backs the database up.
      requireCapability(
        ctx.session,
        'repo.backup',
        'Only the person in the Dark Mechanicus desktop app can back up the whole database: the copy includes private local agent mail.'
      )
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
  requestSavePermission: {
    schema: COMMAND_SCHEMAS.requestSavePermission,
    mutates: true,
    run: (core, input) => requestSavePermission(core.ctx(), input)
  },
  listSavePermissionRequests: {
    mutates: false,
    run: (core) => listSavePermissionRequests(core.ctx())
  },
  decideSavePermission: {
    schema: COMMAND_SCHEMAS.decideSavePermission,
    mutates: true,
    run: (core, input) => decideSavePermission(core.ctx(), input)
  },
  getEventHead: {
    mutates: false,
    run: (core) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'read')
      return latestSeq(ctx, 0)
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
