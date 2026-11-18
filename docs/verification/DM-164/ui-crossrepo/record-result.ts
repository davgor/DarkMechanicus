// DM-164 c28: the agent's step of the runbook's Flow 2 (step 5) on the DM-193 end-state root, after the person pressed
// "Bring back its grades" in the app: an orchestrator session on the source folder records the experiment's statuses
// and its result through the MCP tool `record_experiment_event`, citing one of the grades brought back by
// { reportId, assessmentId } (as `src/integration/spaceLoop.test.ts` does with `statuses` and `recordResult`).
// The app is closed while this runs. Prints each tool answer as JSON.
// Run (from the worktree): node --import ./docs/verification/DM-193/raw-hooks.mjs --import tsx <this> <root> <experimentId> <reportId> <assessmentId> <unit>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openWorkspace } from '../../../../src/core/workspace'
import { createGitAdapter } from '../../../../src/core/repo/git'
import { createMcpServer } from '../../../../src/mcp/server'
import { callTool, withServer } from '../../../../src/test/mcpHarness'

const [root, experimentId, reportId, assessmentId, unit] = process.argv.slice(2)
if (root === undefined || experimentId === undefined || reportId === undefined || assessmentId === undefined || unit === undefined) {
  throw new Error('usage: record-result.ts <root> <experimentId> <reportId> <assessmentId> <unit>')
}
const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')) as { project: { path: string }; dmHome: string }
const info = { name: 'darkmechanicus', version: '0.0.0-dm164' }

async function main(): Promise<void> {
  const path = fixture.project.path
  const workspace = openWorkspace({
    repoRoot: path,
    role: 'orchestrator',
    label: 'orchestrator session (DM-164 c28)',
    transport: 'in_process',
    allowSave: true,
    homeDir: fixture.dmHome,
    git: createGitAdapter(path),
    autoReconcile: false,
    serverInfo: info
  })
  try {
    await withServer(createMcpServer(workspace, info, { role: 'orchestrator', allowSave: true }), async (rig) => {
      const notes: Record<string, string> = { selected: 'Chosen at the checkpoint', scheduled: 'Planned in the checkout epic', in_progress: 'Its work is running', completed: 'Its work landed' }
      for (const status of ['selected', 'scheduled', 'in_progress', 'completed']) {
        const outcome = await callTool(rig, 'record_experiment_event', { experimentId, event: { kind: 'status', status, note: notes[status] } })
        console.log(JSON.stringify({ status, isError: outcome.isError, text: outcome.isError ? outcome.text : undefined }))
      }
      const result = await callTool(rig, 'record_experiment_event', {
        experimentId,
        event: { kind: 'result', result: { assessment: { reportId, assessmentId }, unit }, note: 'checkout Sprint 2 sprint grade' }
      })
      console.log(JSON.stringify({ result: result.isError ? result.text : result.payload }))
      if (result.isError) process.exitCode = 1
    })
  } finally {
    workspace.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
