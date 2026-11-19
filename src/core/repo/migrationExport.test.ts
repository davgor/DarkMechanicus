/** A switch to repository storage writes every portable record the database holds, and only what a checkout may hold. */
import { describe, expect, it } from 'vitest'
import { pngBytes } from '../../test/images'
import { idOf, insertComment, insertEpic } from '../../test/repoFixtures'
import { deliver, report, spaceWorld, type SpaceWorld } from '../../test/spaceWorld'
import { claimAttachments, createStagedAttachment } from '../services/attachments'
import { insertObservationRow, listObservations } from '../services/observations'
import { exportMigrationRecords } from './migrationExport'
import { ownedPaths } from './paths'

const UNSAVED = idOf('epic', 9)
const COMMENT = idOf('comment', 9)

/** A reported sprint, and an epic never saved that holds a comment with an image. */
function populated(): { w: SpaceWorld; reportId: string; imageSha: string } {
  const w = spaceWorld({ overhead: false })
  deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  const reportId = report(w).id
  insertEpic(w.env.db, { id: UNSAVED })
  insertComment(w.env.db, { id: COMMENT, epicId: UNSAVED })
  const image = createStagedAttachment(w.ctx, { bytes: pngBytes(40, 30, 4), label: 'shot', purpose: 'evidence' })
  claimAttachments(w.ctx, [image.id], { kind: 'comment', id: COMMENT })
  return { w, reportId, imageSha: image.sha256 }
}

describe('exportMigrationRecords', () => {
  it('writes the scorecard and every observation of a saved epic beside the run history', () => {
    const { w, reportId } = populated()
    exportMigrationRecords({ db: w.env.db, fs: w.env.fs, layout: w.env.layout, clock: w.env.clock })
    const paths = ownedPaths(w.env.layout)
    expect(JSON.parse(w.env.fs.get(paths.scorecardFile(w.runId, reportId)) ?? '{}')).toMatchObject({ runId: w.runId })
    const observations = listObservations(w.env.db)
    expect(observations.length).toBeGreaterThan(0)
    for (const observation of observations) {
      expect(w.env.fs.get(paths.observationFile(observation.scope.epicId, observation.observationId))).toContain(observation.observationId)
    }
    const synced = w.env.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM sync_state WHERE kind = 'metric_observation'")
    expect(synced?.count).toBe(observations.length)
  })

  it('leaves the images, comments and observations of an epic never saved in the database only', () => {
    const { w, imageSha } = populated()
    const [measured] = listObservations(w.env.db)
    if (measured === undefined) throw new Error('Expected the fixture to hold observations')
    const unsavedObservation = 'mo_01m7gg00000000000000000099'
    const scope = { level: 'epic' as const, epicId: UNSAVED, sprintId: null, runId: null, ticketId: null, attemptId: null }
    insertObservationRow(w.env.db, { ...measured, observationId: unsavedObservation, scope })
    exportMigrationRecords({ db: w.env.db, fs: w.env.fs, layout: w.env.layout, clock: w.env.clock })
    const paths = ownedPaths(w.env.layout)
    expect(w.env.fs.get(paths.commentFile(UNSAVED, COMMENT))).toBeUndefined()
    expect(w.env.fs.get(paths.attachmentFile({ kind: 'epic', id: UNSAVED }, imageSha, 'image/png'))).toBeUndefined()
    expect([...w.env.fs.files().keys()].filter((path) => path.includes(UNSAVED))).toEqual([])
  })
})
