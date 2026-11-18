/** A run history that names a scorecard record the checkout does not hold is refused, not imported without it. */
import { describe, expect, it } from 'vitest'
import { copyTracked, createRepoEnv, createStubGit, dumpDomain, flush, importerDeps } from '../../test/repoEnv'
import { deliver, portable, report, spaceWorld } from '../../test/spaceWorld'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'

describe('importing a run history whose scorecard file is gone', () => {
  it('refuses the run and names the missing scorecard file', () => {
    const w = spaceWorld({ overhead: false })
    portable(w)
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
    const reportId = report(w).id
    expect(flush(w.env).failed).toBe(0)
    const target = createRepoEnv()
    copyTracked(w.env, target)
    const card = ownedPaths(target.layout).scorecardFile(w.runId, reportId)
    target.fs.remove(card)
    const before = dumpDomain(target.db)
    const result = reconcileRepository(importerDeps(target, createStubGit()))
    const shown = `.darkmechanicus/history/${w.runId}/scorecards/${reportId}.json`
    expect(result.rejected).toContainEqual({ path: `.darkmechanicus/history/${w.runId}`, message: `${shown} is missing: the run history names it.` })
    expect(result.imported).not.toContain(w.runId)
    expect(dumpDomain(target.db).runs).toEqual(before.runs)
  })
})
