/**
 * Repository-bound sessions gain no write outside their repository (DM-190 c4): corrective work for the Dark
 * Mechanicus source is written only by the desktop's cross-repository broker, which no role, command or MCP tool
 * reaches, and whose target the renderer can never name.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { capabilitiesForRole, HUMAN_ONLY_CAPABILITIES } from '../core/authz'
import { COMMAND_CAPABILITIES } from '../core/commands/capabilities'
import { beginCrossRepoCorrection, materializeCrossRepoCorrection } from '../core/services/crossRepoCorrections'
import type { Workspace } from '../core/workspace'
import { createCrossRepoCorrectionHandlers } from '../main/desktop/crossRepoCorrections'
import { DESKTOP_COMMANDS } from '../shared/desktop/api'
import type { SessionRole } from '../shared/domain/views'
import { callTool, sampleId, withRig, withServer } from '../test/mcpHarness'
import { createStubApi } from '../test/stubApi'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { createMcpServer } from './server'

const INFO = { name: 'darkmechanicus', version: '0.0.0-test' }
const AGENT_ROLES: SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer', 'reader']
/** What a tool or command reaching another repository would be called. */
const OUTWARD = /cross.?repo|materiali[sz]|receipt|source.?checkout|link.?correction/i

const harnesses: Harness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup()
})

async function project(): Promise<{ harness: Harness; desktop: Workspace }> {
  const harness = createHarness()
  harnesses.push(harness)
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Shop' })
  return { harness, desktop }
}

function codeThrown(action: () => unknown): string {
  try {
    action()
    return 'ok'
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'thrown'
  }
}

describe('cross-repository writes stay with the person (DM-190 c4)', () => {
  it('grants correction.cross_repo to no agent role, even with save, and keeps it human-only at the desktop', () => {
    const holders = AGENT_ROLES.filter((role) => capabilitiesForRole(role, { allowSave: true }).includes('correction.cross_repo'))
    expect(holders).toEqual([])
    expect(HUMAN_ONLY_CAPABILITIES).toContain('correction.cross_repo')
    expect(capabilitiesForRole('desktop')).toContain('correction.cross_repo')
  })

  it('exposes the broker through no command a session or the desktop command channel can call', () => {
    const commands = Object.entries(COMMAND_CAPABILITIES)
    expect(commands.filter(([name, capability]) => OUTWARD.test(name) || capability === 'correction.cross_repo')).toEqual([])
    expect(DESKTOP_COMMANDS.filter((name) => OUTWARD.test(name))).toEqual([])
  })

  it.each(AGENT_ROLES)('lists no tool to a %s session that writes to another repository', async (role) => {
    await withRig((api) => createMcpServer(api, INFO, { role, allowSave: true }), createStubApi(), async (rig) => {
      const tools = (await rig.client.listTools()).tools.map((tool) => tool.name)
      expect(tools.filter((name) => OUTWARD.test(name))).toEqual([])
      expect(tools.length).toBeGreaterThan(30)
    })
  })

  it('refuses over MCP an epic whose provenance claims a cross-repository correction', async () => {
    const { harness } = await project()
    const orchestrator = harness.open('orchestrator')
    await withServer(createMcpServer(orchestrator, INFO, { role: 'orchestrator', allowSave: true }), async (rig) => {
      const forged = await callTool(rig, 'create_epic', {
        title: 'Forged correction',
        provenance: { kind: 'cross_repo_correction', key: `${sampleId('report')}/${sampleId('experiment')}/from:${sampleId('project', 1)}/to:${sampleId('project', 2)}`, target: { projectId: sampleId('project', 2) } }
      })
      expect(forged.payload).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    })
    expect(await orchestrator.listEpics()).toEqual([])
  })

  it.each(AGENT_ROLES)('refuses a %s session both halves of a cross-repository write in the core', async (role) => {
    const { harness } = await project()
    const ctx = harness.open(role, { allowSave: true }).ctx()
    const begin = codeThrown(() => beginCrossRepoCorrection(ctx, {} as never, { projectId: sampleId('project', 2) }))
    const materialize = codeThrown(() => materializeCrossRepoCorrection(ctx, {} as never, { expected: null, closed: null }))
    expect({ begin, materialize }).toEqual({ begin: 'unauthorized', materialize: 'unauthorized' })
  })

  it('lets the desktop past the capability check, so the refusal above is the role’s', async () => {
    const { desktop } = await project()
    const begin = codeThrown(() => beginCrossRepoCorrection(desktop.ctx(), {} as never, { projectId: sampleId('project', 2) }))
    expect(begin).toBe('invalid_input')
  })
})

describe('the cross-repository broker never takes its target from the renderer (DM-190 c4)', () => {
  it('refuses an untracked source folder and any request naming a target, before consulting the chosen checkout', async () => {
    const { harness, desktop } = await project()
    const consulted: string[] = []
    const broker = createCrossRepoCorrectionHandlers({
      registry: { resolve: (path) => (path === harness.root ? path : null) },
      pool: { get: () => desktop },
      checkouts: {
        view: () => (consulted.push('view'), { status: 'none', target: null, local: null, problem: null, message: null, recovery: null }),
        requireAvailable: () => (consulted.push('requireAvailable'), { path: harness.root, target: { kind: 'darkmechanicus_source', projectId: sampleId('project', 2), projectName: 'x' } })
      },
      onUnexpectedError: (error) => {
        throw error
      }
    })
    const input = { reportId: sampleId('report'), experimentId: sampleId('experiment'), expectedTargetProjectId: sampleId('project', 2) }
    const untracked = await broker.createCrossRepoCorrection(`${harness.root}-elsewhere`, input)
    const named = await broker.createCrossRepoCorrection(harness.root, { ...input, target: { path: harness.root } })
    expect(untracked).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(named).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(consulted).toEqual([])
  })
})
