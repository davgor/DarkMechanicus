// DM-193 real-app evidence seed: builds the two-repository fixture of `src/integration/spaceLoop.test.ts` into `<root>`
// (its own userData, Dark Mechanicus home and home directory) so the built or packaged app can open it isolated.
// The Dark Mechanicus side is a real `git clone` of this repository at `<branch>`, with its `.darkmechanicus/` records
// removed in one commit so the clone starts as a fresh project (never the live run's records). The person's choice of
// that checkout is saved in `userData/source-checkout.json`. Writes `<root>/fixture.json`: the folders, ids, the build
// commit and every MCP scorecard/metrics read (the `reader` role) the screens are compared against.
// Run: npx tsx docs/verification/DM-193/seed.ts <root> [branch]
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callTool, withServer } from '../../../src/test/mcpHarness'
import { openGitRepo } from '../../../src/test/gitRepo'
import { complete, correctLocal, report1, requestDm, sprint1, sprint2, sprint3, workDm } from '../../../src/test/spaceLoop'
import { twoRepoMachine } from '../../../src/test/twoRepoMachine'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const [rootArg, branchArg] = process.argv.slice(2)
if (rootArg === undefined) throw new Error('usage: seed.ts <root> [branch]')
const root = resolve(rootArg)
const branch =
  branchArg ??
  execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
const buildCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
  encoding: 'utf8'
}).trim()
mkdirSync(root, { recursive: true })

const cloneAt = (dest: string) => {
  execFileSync('git', ['clone', '-q', '--branch', branch, repo, dest])
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dest, '-c', 'user.name=DM-193 seed', '-c', 'user.email=seed@localhost', ...args], { encoding: 'utf8' })
  git('rm', '-r', '-q', '--', '.darkmechanicus')
  git('commit', '-q', '-m', 'seed: start the controlled checkout as a fresh project')
  return openGitRepo(dest, 1_000, () => undefined)
}

async function main(): Promise<void> {
  const m = twoRepoMachine({ root, dmCheckout: cloneAt })
  try {
    const s = await sprint1(m)
    const r = await report1(m, s)
    const c = await correctLocal(m, s, r)
    const req = await requestDm(m, r)
    const w = await workDm(m, req)
    await complete(m.dm, w.ledger.runId, w.reports[1].id)
    const rep2 = await sprint2(m, s, c)
    const rep3 = await sprint3(m, s, c)
    await complete(m.project, s.ledger.runId, rep3.id)
    const { runId } = s.ledger
    const reads: Record<string, unknown> = {}
    await withServer(m.mcp(m.project, 'reader'), async (rig) => {
      const read = async (key: string, tool: string, args: Record<string, unknown>) => {
        const outcome = await callTool(rig, tool, args)
        if (outcome.isError) throw new Error(`${tool} failed: ${JSON.stringify(outcome.payload)}`)
        reads[key] = outcome.payload
      }
      for (const [name, ticketId] of Object.entries(s.tickets)) await read(`ticket:${name}`, 'get_ticket_grade', { runId, ticketId })
      await read('sprint', 'get_sprint_grade', { runId, sprintId: s.sprintId })
      await read('epic', 'get_epic_grade', { epicId: s.epicId })
      await read('report1', 'get_report_scorecard', { reportId: r.report.id })
      await read('metrics', 'get_metrics_summary', {})
    })
    m.chooseCheckout()
    const fixture = {
      buildCommit,
      branch,
      root,
      userData: m.userData,
      dmHome: m.dmHome,
      home: m.home,
      project: {
        path: m.project.path,
        name: m.project.name,
        epicId: s.epicId,
        runId,
        sprintId: s.sprintId,
        tickets: s.tickets,
        reports: [r.report.id, rep2.id, rep3.id]
      },
      dm: { path: m.dm.path, epicId: req.epicId, runId: w.ledger.runId },
      unexpected: m.unexpected,
      reads
    }
    writeFileSync(join(root, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`)
    console.log(`seeded ${root}`)
  } finally {
    m.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
