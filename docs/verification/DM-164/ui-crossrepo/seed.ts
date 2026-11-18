// DM-164 c25/c27/c28 real-app seed: the DM-193 two-repository fixture (`src/test/twoRepoMachine.ts`) built into `<root>`,
// stopped BEFORE `requestDm`, so the Dark Mechanicus checkout is not chosen and no cross-repository correction exists.
//   stop=completed: "Checkout flow" planned as one sprint, run, reported as the epic's last report (spaceCorrections'
//                   `reported({ completed: true })`) and approved: the epic is completed; its Sprint 1 report and
//                   Improvement tab are shown in the epic overview, and its `dm` experiment has no correction yet.
//                   (Mid-run, an approved report's Improvement tab is shown nowhere in the desktop: only the open
//                   checkpoint's report or a completed epic's overview carries it.)
//   stop=report1:      Sprint 1 run and reported; its checkpoint is still open (Flow 1 untouched).
// The Dark Mechanicus side is a real `git clone` of this repository at `<branch>` (records removed in one commit, as
// DM-193's seed does), set up as project "DarkMechanicus" (the person's set-up step `requestDm` performs). `dm-other`
// is a local clone of that checkout set up as ANOTHER project ("Other Mechanicus"), untracked: the wrong-project fixture.
// Writes `<root>/fixture.json` with the folders and ids the driver needs.
// Run (from the worktree): node --import ./docs/verification/DM-193/raw-hooks.mjs --import tsx <this> <root> <stop> [branch]
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openGitRepo } from '../../../../src/test/gitRepo'
import { complete, report1, sprint1 } from '../../../../src/test/spaceLoop'
import { twoRepoMachine } from '../../../../src/test/twoRepoMachine'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const [rootArg, stopArg, branchArg] = process.argv.slice(2)
if (rootArg === undefined || (stopArg !== 'completed' && stopArg !== 'report1')) throw new Error('usage: seed.ts <root> completed|report1 [branch]')
const root = resolve(rootArg)
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const branch = branchArg ?? git('-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD')
const buildCommit = git('-C', repo, 'rev-parse', 'HEAD')
mkdirSync(root, { recursive: true })

const cloneAt = (dest: string) => {
  execFileSync('git', ['clone', '-q', '--branch', branch, repo, dest])
  const inClone = (...args: string[]) =>
    execFileSync('git', ['-C', dest, '-c', 'user.name=DM-164 seed', '-c', 'user.email=seed@localhost', ...args], { encoding: 'utf8' })
  inClone('rm', '-r', '-q', '--', '.darkmechanicus')
  inClone('commit', '-q', '-m', 'seed: start the controlled checkout as a fresh project')
  return openGitRepo(dest, 1_000, () => undefined)
}

async function main(): Promise<void> {
  const m = twoRepoMachine({ root, dmCheckout: cloneAt })
  try {
    const s = await sprint1(m)
    const r = await report1(m, s, { final: stopArg === 'completed' })
    if (stopArg === 'completed') await complete(m.project, s.ledger.runId, r.report.id)
    // The person's set-up of the checkout (as `requestDm` does first); the choice itself is left to the desktop.
    await m.dm.desktop.initializeRepository({ name: 'DarkMechanicus', keyPrefix: 'DM' })
    const dmProject = await m.dm.desktop.getProject()
    const otherPath = join(m.root, 'dm-other')
    execFileSync('git', ['clone', '-q', m.dm.path, otherPath])
    const other = m.openAt(otherPath, 'desktop', '2026-11-16T07:00:00.000Z')
    await other.initializeRepository({ name: 'Other Mechanicus', keyPrefix: 'OM' })
    const otherProject = await other.getProject()
    const fixture = {
      buildCommit,
      branch,
      stop: stopArg,
      root: m.root,
      userData: m.userData,
      dmHome: m.dmHome,
      home: m.home,
      project: {
        path: m.project.path,
        name: m.project.name,
        epicId: s.epicId,
        runId: s.ledger.runId,
        sprintId: s.sprintId,
        reportId: r.report.id,
        experiments: { local: r.xp.local.id, dm: r.xp.dm.id }
      },
      dm: { path: m.dm.path, projectId: dmProject.projectId, projectName: dmProject.name },
      other: { path: otherPath, projectId: otherProject.projectId, projectName: otherProject.name },
      unexpected: m.unexpected
    }
    writeFileSync(join(m.root, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`)
    console.log(`seeded ${m.root}`)
  } finally {
    m.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
