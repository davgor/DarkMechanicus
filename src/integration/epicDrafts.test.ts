import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWorkspace, type Workspace } from '../core/workspace'
import { createFolderRegistry } from '../main/desktop/folderRegistry'
import { createDesktopHandlers, type DesktopHandlers } from '../main/desktop/handlers'
import { createWorkspacePool } from '../main/desktop/workspacePool'
import type { CommandName } from '../shared/domain/api'
import type { EpicSummaryView, PlanView } from '../shared/domain/views'
import { TWO_TICKETS } from '../test/authoring'
import { createSequentialIds, createTestClock } from '../test/testContext'
import { createFakeGit } from '../test/workspaceHarness'

/**
 * DM-11: "when you pull one epic out of draft it pulls all epics out of draft." The desktop acts on
 * one epic through dm:command while planner sessions (as over MCP) own the plans; every other epic,
 * in the same folder and in a second tracked folder, must keep its draft exactly as it was.
 */
interface Desktop {
  handlers: DesktopHandlers
  folders: { one: string; two: string }
  planners: { one: Workspace; two: Workspace }
  cleanup(): void
}

function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

function createDesktop(): Desktop {
  const folders = { one: tempDir('dm-drafts-one-'), two: tempDir('dm-drafts-two-') }
  const config = tempDir('dm-drafts-config-')
  const clock = createTestClock('2026-10-01T14:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'c'.repeat(40), detached: false })
  const open = (repoRoot: string, role: 'desktop' | 'planner'): Workspace =>
    openWorkspace({ repoRoot, role, label: role, transport: 'in_process', allowSave: true, clock, ids, git })
  const planners = { one: open(folders.one, 'planner'), two: open(folders.two, 'planner') }
  const registry = createFolderRegistry({ file: join(config, 'folders.json'), homeDir: config })
  registry.track(folders.one)
  registry.track(folders.two)
  const pool = createWorkspacePool((repoRoot) => open(repoRoot, 'desktop'))
  const handlers = createDesktopHandlers({
    registry,
    pool,
    pickDirectory: async () => null,
    writeClipboard: () => undefined,
    openExternal: async () => undefined,
    mcpConfig: () => ({ command: '', args: [], env: {}, json: '{}', note: '' }),
    installSkills: () => ({ written: [] })
  })
  return {
    handlers,
    folders,
    planners,
    cleanup() {
      pool.closeAll()
      planners.one.close()
      planners.two.close()
      for (const dir of [folders.one, folders.two, config]) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}

async function command<T>(desktop: Desktop, folder: string, name: CommandName, input?: unknown): Promise<T> {
  const result = await desktop.handlers.command(folder, name, input)
  if (!result.ok) {
    throw new Error(`${name} failed: ${result.error.code} ${result.error.message}`)
  }
  return result.data as T
}

/** A planned epic with an unsaved draft: never saved, or saved once and then edited again. */
async function planEpic(planner: Workspace, title: string, saved: boolean): Promise<string> {
  const epic = await planner.createEpic({ title, intent: `Ship ${title}`, successCriteria: ['It works'] })
  const update = await planner.updatePlanDraft({ epicId: epic.id, ops: TWO_TICKETS, expectedDraftRevision: 1 })
  if (saved) {
    await planner.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
    await planner.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'set_rationale', rationale: `Rework ${title}` }] })
  }
  return epic.id
}

interface Planned {
  target: string
  /** Every other epic, keyed by a readable name. */
  others: Record<string, { folder: string; epicId: string }>
}

async function planEpics(desktop: Desktop): Promise<Planned> {
  const { folders, planners } = desktop
  await planners.one.initializeRepository({ name: 'one' })
  await planners.two.initializeRepository({ name: 'two' })
  const target = await planEpic(planners.one, 'Target', true)
  const others = {
    'never-saved sibling': { folder: folders.one, epicId: await planEpic(planners.one, 'Sibling draft', false) },
    'saved sibling': { folder: folders.one, epicId: await planEpic(planners.one, 'Sibling saved', true) },
    'never-saved epic in another folder': { folder: folders.two, epicId: await planEpic(planners.two, 'Far draft', false) },
    'saved epic in another folder': { folder: folders.two, epicId: await planEpic(planners.two, 'Far saved', true) }
  }
  return { target, others }
}

interface DraftState {
  /** Everything the sidebar row (status line and badges) and list_epics show for the epic. */
  summary: EpicSummaryView | undefined
  draft: Pick<PlanView, 'draftRevision' | 'baseRevisionId' | 'contentHash'> | null
}

async function draftState(desktop: Desktop, folder: string, epicId: string): Promise<DraftState> {
  const summary = (await command<EpicSummaryView[]>(desktop, folder, 'listEpics')).find((epic) => epic.id === epicId)
  if (summary?.hasDraft !== true) {
    return { summary, draft: null }
  }
  const draft = await command<PlanView>(desktop, folder, 'getPlan', { epicId, view: 'draft' })
  return { summary, draft: { draftRevision: draft.draftRevision, baseRevisionId: draft.baseRevisionId, contentHash: draft.contentHash } }
}

async function otherStates(desktop: Desktop, planned: Planned): Promise<Record<string, DraftState>> {
  const states: Record<string, DraftState> = {}
  for (const [name, other] of Object.entries(planned.others)) {
    states[name] = await draftState(desktop, other.folder, other.epicId)
  }
  return states
}

async function targetDraftRevision(desktop: Desktop, epicId: string): Promise<number> {
  const draft = await command<PlanView>(desktop, desktop.folders.one, 'getPlan', { epicId, view: 'draft' })
  return draft.draftRevision ?? 0
}

type Action = (desktop: Desktop, epicId: string) => Promise<unknown>

const ACTIONS: [string, Action, Partial<EpicSummaryView>][] = [
  [
    'saving its draft',
    async (desktop, epicId) =>
      command(desktop, desktop.folders.one, 'savePlan', { epicId, expectedDraftRevision: await targetDraftRevision(desktop, epicId) }),
    { hasDraft: false, currentRevisionNumber: 2 }
  ],
  [
    'discarding its draft',
    (desktop, epicId) => command(desktop, desktop.folders.one, 'discardPlanDraft', { epicId }),
    { hasDraft: false, currentRevisionNumber: 1 }
  ],
  [
    'moving it to in progress',
    (desktop, epicId) => command(desktop, desktop.folders.one, 'setEpicStatus', { epicId, status: 'in_progress' }),
    { hasDraft: true, status: 'in_progress' }
  ],
  [
    'queueing a run',
    (desktop, epicId) => command(desktop, desktop.folders.one, 'queueRun', { epicId }),
    { hasDraft: true, run: expect.objectContaining({ state: 'queued' }) as EpicSummaryView['run'] }
  ],
  [
    'saving, then opening a fresh draft (Edit draft)',
    async (desktop, epicId) => {
      await ACTIONS[0]?.[1](desktop, epicId)
      return command(desktop, desktop.folders.one, 'openDraft', { epicId })
    },
    { hasDraft: true, draftRevision: 1, draftChanged: false }
  ]
]

describe('an action on one epic leaves every other epic draft alone', () => {
  let desktop: Desktop

  beforeEach(() => {
    desktop = createDesktop()
  })

  afterEach(() => {
    desktop.cleanup()
  })

  it.each(ACTIONS)('after %s', async (_name, action, targetAfter) => {
    const planned = await planEpics(desktop)
    const before = await otherStates(desktop, planned)
    expect(Object.values(before).map((state) => [state.summary?.hasDraft, state.summary?.draftChanged])).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true]
    ])
    await action(desktop, planned.target)
    expect((await draftState(desktop, desktop.folders.one, planned.target)).summary).toMatchObject(targetAfter)
    expect(await otherStates(desktop, planned)).toEqual(before)
  })
})
