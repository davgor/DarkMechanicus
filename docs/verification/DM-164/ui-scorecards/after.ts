// DM-164: the MCP reads (`reader` role) of a seeded root after the built app was closed, so what the person did in
// the app (c15 reassess, c16 rating and budget, c23 corrective draft) is read back through the MCP channel. Opens its
// own session on the project folder (the root's Dark Mechanicus home, real clock) and writes <root>/after.json.
// Run from the worktree root, with the app closed:
//   node --import ./docs/verification/DM-193/raw-hooks.mjs --import tsx docs/verification/DM-164/ui-scorecards/after.ts <root>
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createGitAdapter } from '../../../../src/core/repo/git'
import { openWorkspace } from '../../../../src/core/workspace'
import { createMcpServer } from '../../../../src/mcp/server'
import { callTool, withServer } from '../../../../src/test/mcpHarness'

const rootArg = process.argv[2]
if (rootArg === undefined) throw new Error('usage: after.ts <root>')
const root = resolve(rootArg)
const f = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
const p = f.project
const info = { name: 'darkmechanicus', version: '0.0.0-dm164' }

function asks(): [string, string, Record<string, unknown>][] {
  const runId = p.runId
  switch (f.variant) {
    case 'regress':
      return [
        ['report1', 'get_report_scorecard', { reportId: p.reports[0], reportRevision: p.report1Revision }],
        ['reassess1', 'reassess_report_scorecard', { reportId: p.reports[0] }],
        ['epic', 'get_epic_grade', { epicId: p.epicId }]
      ]
    case 'report1':
      return [
        ...Object.entries(p.tickets as Record<string, string>).map(([name, ticketId]): [string, string, Record<string, unknown>] => [`ticket:${name}`, 'get_ticket_grade', { runId, ticketId }]),
        ['report1', 'get_report_scorecard', { reportId: p.reportId, reportRevision: p.reportRevision }],
        ['reassess1', 'reassess_report_scorecard', { reportId: p.reportId }],
        ['run', 'get_run', { epicId: p.epicId }],
        ['epic', 'get_epic', { epicId: p.epicId }],
        ['epics', 'list_epics', {}],
        ['draft', 'get_plan', { epicId: p.epicId, view: 'draft' }],
        ['saved', 'get_plan', { epicId: p.epicId, view: 'saved' }],
        ['baselines', 'get_planned_baselines', { epicId: p.epicId, runId }],
        ['experimentLocal', 'get_experiment', { experimentId: p.experiments.local }],
        ['signals', 'get_space_signals', { level: 'sprint', id: p.sprintId, runId }],
        ['signalsApi', 'get_space_signals', { level: 'ticket', id: p.tickets.api, runId }]
      ]
    default:
      return []
  }
}

async function main(): Promise<void> {
  const workspace = openWorkspace({
    repoRoot: p.path,
    role: 'reader',
    label: 'reader session (DM-164 after-read)',
    transport: 'in_process',
    homeDir: f.dmHome,
    git: createGitAdapter(p.path),
    autoReconcile: false,
    serverInfo: info
  })
  const reads: Record<string, unknown> = {}
  try {
    await withServer(createMcpServer(workspace, info, { role: 'reader', allowSave: false }), async (rig) => {
      for (const [key, tool, args] of asks()) {
        const outcome = await callTool(rig, tool, args)
        reads[key] = outcome.isError ? { error: outcome.payload ?? outcome.text, tool, args } : outcome.payload
      }
    })
    const approvals = workspace.ctx().db.all('SELECT id, run_id, sprint_id, report_id, report_hash, action, issued_by, issued_at, consumed_at FROM approvals WHERE run_id = ? ORDER BY issued_at', p.runId)
    const runs = workspace.ctx().db.all('SELECT id, number, state, revision_id, active_sprint_id, created_at, started_at, updated_at, ended_at, (SELECT COUNT(*) FROM attempts a WHERE a.run_id = runs.id) AS attempts FROM runs WHERE epic_id = ? ORDER BY number', p.epicId)
    writeFileSync(join(root, 'after.json'), `${JSON.stringify({ readAt: new Date().toISOString(), reads, approvals, runs }, null, 2)}\n`)
    console.log(`read ${root}`)
  } finally {
    workspace.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
