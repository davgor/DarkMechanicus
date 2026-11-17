/** An imported report is searchable by the tickets its retro names, by key when the run's plan has it, else by id. */
import { describe, expect, it } from 'vitest'
import { delivered, portable, submit } from '../../test/experimentWorld'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { contentHash, prettyJson } from '../canonical'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'

interface ReportEntry {
  id: string
  contentHash: string
  scorecard?: unknown
  content: { retro: { leftovers?: { ticket: string; reason: string }[] } }
}

describe('indexing an imported report', () => {
  it('names a leftover ticket outside the run plan by its id', () => {
    const w = delivered()
    portable(w)
    const report = submit(w, { summary: 'Sprint 1 is over.', retro: { actions: ['Keep reviews short'] } })
    flush(w.env)
    const b = createRepoEnv()
    copyTracked(w.env, b)
    const file = ownedPaths(b.layout).runHistoryFile(w.runId)
    const run = JSON.parse(b.fs.get(file) ?? '{}') as { reports: ReportEntry[] }
    const outside = idOf('ticket', 77)
    for (const entry of run.reports) {
      delete entry.scorecard
      entry.content.retro.leftovers = [{ ticket: outside, reason: 'Moved to a later epic' }]
      entry.contentHash = contentHash(entry.content)
    }
    b.fs.put(file, prettyJson(run))
    const result = reconcileRepository(importerDeps(b, createStubGit()))
    expect(result.imported).toContain(w.runId)
    const indexed = b.db.get<{ body: string }>("SELECT body FROM search_index WHERE doc_type = 'report' AND doc_id = ?", report.id)
    expect(indexed?.body).toContain(`${outside}\nMoved to a later epic`)
  })
})
