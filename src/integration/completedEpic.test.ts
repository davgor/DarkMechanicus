import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWorkspace } from '../core/workspace'
import { createFolderRegistry } from '../main/desktop/folderRegistry'
import { createDesktopHandlers, type DesktopHandlers } from '../main/desktop/handlers'
import { buildMcpConfig } from '../main/desktop/mcpConfig'
import { createWorkspacePool } from '../main/desktop/workspacePool'
import type { CommandResult } from '../shared/desktop/api'
import type { EpicDetailView, PlanView, RunView, SprintReportView } from '../shared/domain/views'
import { createSequentialIds, createTestClock } from '../test/testContext'
import { createFakeGit } from '../test/workspaceHarness'

/** The completed "MCP connection test" epic committed in this repository's portable state. */
const TRACKED = fileURLToPath(new URL('../../.darkmechanicus', import.meta.url))
const EPIC = 'ep_01m3txy30qavmd5wewct90804g'
const RUN = 'rn_01m3txzt9wj79mxsq50f5ktf1q'
const SPRINT = 'sp_01m3txy30q8sb4f7ekx20btcr6'
const FIXTURE = ['project.json', join('epics', EPIC), join('history', RUN)]

interface Desktop {
  handlers: DesktopHandlers
  repo: string
  cleanup(): void
}

/** A fresh clone: only the fixture's tracked records, no local database. */
function cloneFixture(): string {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-completed-repo-')))
  for (const path of FIXTURE) {
    mkdirSync(join(repo, '.darkmechanicus', path, '..'), { recursive: true })
    cpSync(join(TRACKED, path), join(repo, '.darkmechanicus', path), { recursive: true })
  }
  return repo
}

function createDesktop(repo: string, config: string): Desktop {
  const clock = createTestClock('2026-10-02T09:00:00.000Z')
  const git = createFakeGit({ branch: 'main', commit: 'c'.repeat(40), detached: false })
  const ids = createSequentialIds()
  const pool = createWorkspacePool((repoRoot) =>
    openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', clock, ids, git })
  )
  const handlers = createDesktopHandlers({
    registry: createFolderRegistry({ file: join(config, 'folders.json'), homeDir: config }),
    pool,
    pickDirectory: async () => repo,
    writeClipboard: () => undefined,
    openExternal: async () => undefined,
    mcpConfig: (repoPath) => buildMcpConfig({ packaged: false, execPath: 'electron', appPath: '/app', repoPath }),
    installSkills: () => ({ written: [] }),
    connectClaudeCode: () => ({ outcome: 'unchanged' }),
    previewBoardRemoval: () => ({ remove: [], kept: [], editByHand: [] }),
    removeBoardFiles: () => ({ removed: [], removedFolders: [], kept: [], editByHand: [] })
  })
  return { handlers, repo, cleanup: () => pool.closeAll() }
}

function dataOf<T>(result: CommandResult<unknown>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.data as T
}

/** The reads the renderer's workspace load makes for a completed epic. */
async function overviewReads(desktop: Desktop): Promise<{ epic: EpicDetailView; run: RunView; plan: PlanView; report: SprintReportView }> {
  const command = (name: string, input: unknown): Promise<CommandResult<unknown>> => desktop.handlers.command(desktop.repo, name, input)
  const epic = dataOf<EpicDetailView>(await command('getEpic', { epicId: EPIC }))
  const run = dataOf<RunView>(await command('getRun', { epicId: EPIC }))
  const plan = dataOf<PlanView>(await command('getPlan', { epicId: EPIC, view: 'saved' }))
  const report = dataOf<SprintReportView>(await command('getSprintReport', { runId: RUN, sprintId: SPRINT }))
  return { epic, run, plan, report }
}

interface FixtureDesktop {
  current(): Desktop
  /** Closes the app's workspaces and opens them again on the same checkout. */
  restart(): void
}

/** Per test: a fresh clone of the fixture, tracked by a desktop over the real Workspace. */
function useFixtureDesktop(): FixtureDesktop {
  let config = ''
  let desktop: Desktop | undefined
  const current = (): Desktop => desktop ?? fail('The fixture desktop exists only inside a test.')
  beforeEach(async () => {
    config = mkdtempSync(join(tmpdir(), 'dm-completed-config-'))
    desktop = createDesktop(cloneFixture(), config)
    await desktop.handlers.pickFolder()
  })
  afterEach(() => {
    const { repo } = current()
    current().cleanup()
    rmSync(repo, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  })
  return {
    current,
    restart() {
      current().cleanup()
      desktop = createDesktop(current().repo, config)
    }
  }
}

function fail(message: string): never {
  throw new Error(message)
}

describe('a completed epic read from portable state', () => {
  const fixture = useFixtureDesktop()

  it('serves the recorded outcome, the completed run and its sprint report to a fresh clone', async () => {
    expect(existsSync(join(fixture.current().repo, '.darkmechanicus', 'local'))).toBe(false)
    const { epic, run, plan, report } = await overviewReads(fixture.current())
    expect([epic.title, epic.status]).toEqual(['MCP connection test', 'completed'])
    expect(epic.outcome?.summary).toMatch(/^The MCP authoring and execution path works end to end/)
    expect(epic.outcome?.successCriteria.map((item) => [item.criterionId, item.met])).toEqual([
      ['s1', true],
      ['s2', true]
    ])
    expect(epic.outcome?.successCriteria[1]?.note).toBe('Draft saved as revision 1 from the desktop (DM-2 accepted).')
    expect([run.id, run.state, run.activeSprintId, run.checkpoint, run.revisionId]).toEqual([RUN, 'completed', null, null, plan.revisionId])
    expect(plan.bundle.sprints.map((item) => item.id)).toEqual([SPRINT])
    expect(plan.bundle.epic.successCriteria.map((item) => item.text)).toEqual([
      'Epic and tickets appear in the desktop app',
      'A person can Save or discard the draft'
    ])
    expect([report.id, report.submittedBy, report.report.epicOutcome?.successCriteria.length]).toEqual([
      'rp_01m3ty66d960gb6z5bt9y4th60',
      'Claude Code (orchestrator)',
      2
    ])
    expect(report.report.summary).toMatch(/^Sprint 1 confirmed the full MCP loop/)
  })

  it('has no live checkpoint for the completed run, so the checkpoint read cannot carry the overview', async () => {
    const checkpoint = await fixture.current().handlers.command(fixture.current().repo, 'getCheckpoint', { runId: RUN })
    expect(checkpoint.ok ? 'ok' : checkpoint.error.code).toBe('run_not_active')
  })
})

describe('a completed epic after the app restarts', () => {
  const fixture = useFixtureDesktop()

  it('still serves the overview from the local database on the same checkout', async () => {
    await overviewReads(fixture.current())
    fixture.restart()
    expect(existsSync(join(fixture.current().repo, '.darkmechanicus', 'local'))).toBe(true)
    const { epic, run, report } = await overviewReads(fixture.current())
    expect([epic.outcome?.runId, run.state, report.sprintId]).toEqual([RUN, 'completed', SPRINT])
  })
})
