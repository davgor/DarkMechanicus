/** Observation record files that cannot be trusted are each rejected with the reason, and nothing of them is stored. */
import { describe, expect, it } from 'vitest'
import { createRepoEnv, createStubGit, importerDeps, initProject, type RepoEnv, saveRevision } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { createTestCtx } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { listObservations, type ObservationInput, recordObservations } from '../services/observations'
import { LEDGER_LIMITS } from '../space/ledger'
import { importObservations } from './observationImport'
import { ownedPaths } from './paths'
import { buildObservationRecord, MAX_OBSERVATION_RECORD_BYTES } from './portable'

const EPIC = idOf('epic', 1)
const PROJECT_OBSERVATION = 'mo_01m7gg00000000000000000001'
const EPIC_OBSERVATION = 'mo_01m7gg00000000000000000002'

const projectLevel: ObservationInput = {
  observationId: PROJECT_OBSERVATION,
  metric: 'tokens_total',
  unit: 'tokens',
  scope: { level: 'project', epicId: null, sprintId: null, runId: null, ticketId: null, attemptId: null },
  source: { kind: 'host', actor: 'codex-adapter' },
  measurement: { state: 'missing', reason: 'host_unavailable' },
  accumulation: 'delta',
  sequence: null,
  observedAt: '2026-11-15T11:59:58.000Z',
  attributes: { bucket: 'project_overhead' },
  evidence: []
}

const epicLevel: ObservationInput = {
  ...projectLevel,
  observationId: EPIC_OBSERVATION,
  metric: 'human_rating',
  unit: 'rating_1_5',
  accumulation: 'event',
  scope: { level: 'epic', epicId: EPIC, sprintId: null, runId: null, ticketId: null, attemptId: null },
  source: { kind: 'human', actor: 'desktop' },
  measurement: { state: 'observed', value: 4 },
  attributes: { question: 'confidence' }
}

/** The record file texts another machine exported for one project-level and one epic-level observation. */
function exportedTexts(): Map<string, string> {
  const a = createRepoEnv({ root: '/machine-a' })
  initProject(a)
  saveRevision(a, { epicId: EPIC, revisionId: idOf('revision', 1), number: 1 })
  recordObservations(createTestCtx({ db: a.db, clock: a.clock }), [projectLevel, epicLevel])
  return new Map([PROJECT_OBSERVATION, EPIC_OBSERVATION].map((id) => [id, prettyJson(buildObservationRecord(a.db, id))]))
}

/** This machine, which holds the epic and no observations yet. */
function machineB(): RepoEnv {
  const b = createRepoEnv({ root: '/machine-b' })
  initProject(b)
  saveRevision(b, { epicId: EPIC, revisionId: idOf('revision', 1), number: 1 })
  return b
}

const importInto = (b: RepoEnv) => importObservations(importerDeps(b, createStubGit()), b.clock.nowIso())
const projectDir = (b: RepoEnv) => ownedPaths(b.layout).observationsDir(null)
const epicDir = (b: RepoEnv) => ownedPaths(b.layout).observationsDir(EPIC)

describe('importing observation folders', () => {
  it('imports both folders, then refuses a file in place of a folder on its own', () => {
    const texts = exportedTexts()
    const b = machineB()
    b.fs.put(ownedPaths(b.layout).observationFile(null, PROJECT_OBSERVATION), texts.get(PROJECT_OBSERVATION) ?? '')
    b.fs.put(ownedPaths(b.layout).observationFile(EPIC, EPIC_OBSERVATION), texts.get(EPIC_OBSERVATION) ?? '')
    expect(importInto(b)).toEqual({ imported: [PROJECT_OBSERVATION, EPIC_OBSERVATION], rejected: [] })
    b.fs.removeTree(projectDir(b))
    b.fs.put(projectDir(b), 'oops')
    expect(importInto(b).rejected).toEqual([{ path: '.darkmechanicus/observations', message: '.darkmechanicus/observations is not a directory.' }])
  })

  it('refuses a folder with more observations than the ledger allows, without reading any', () => {
    const b = machineB()
    b.fs.mkdirp(epicDir(b))
    b.fs.setReaddir(epicDir(b), Array.from({ length: LEDGER_LIMITS.perFolder + 1 }, (_, index) => `mo_${String(index).padStart(26, '0')}.json`))
    const shown = `.darkmechanicus/epics/${EPIC}/observations`
    expect(importInto(b)).toEqual({
      imported: [],
      rejected: [{ path: shown, message: `${shown} holds more than ${LEDGER_LIMITS.perFolder} metric observations.` }]
    })
  })

  it('rejects a file that fails on every pass with the reason its insert threw', () => {
    const citing: ObservationInput = { ...projectLevel, evidence: [{ kind: 'observation', id: EPIC_OBSERVATION, detail: null }] }
    const a = createRepoEnv({ root: '/machine-a' })
    initProject(a)
    saveRevision(a, { epicId: EPIC, revisionId: idOf('revision', 1), number: 1 })
    recordObservations(createTestCtx({ db: a.db, clock: a.clock }), [epicLevel, citing])
    const b = machineB()
    b.fs.put(ownedPaths(b.layout).observationFile(null, PROJECT_OBSERVATION), prettyJson(buildObservationRecord(a.db, PROJECT_OBSERVATION)))
    expect(importInto(b)).toEqual({
      imported: [],
      rejected: [
        {
          path: `.darkmechanicus/observations/${PROJECT_OBSERVATION}.json`,
          message: `Could not be applied: Evidence observation ${EPIC_OBSERVATION} does not exist in this project.`
        }
      ]
    })
    expect(listObservations(b.db)).toEqual([])
  })
})

describe('importing hostile observation files', () => {
  it.each([
    ['a folder named like a record', (b: RepoEnv, file: string) => b.fs.mkdirp(file), 'is not a regular file'],
    ['a file over the observation limit', (b: RepoEnv, file: string) => b.fs.put(file, ' '.repeat(MAX_OBSERVATION_RECORD_BYTES + 1)), 'is larger than the 256 KiB observation limit'],
    ['a listed file that is gone', (b: RepoEnv) => b.fs.setReaddir(projectDir(b), [`${PROJECT_OBSERVATION}.json`]), 'is missing']
  ])('refuses %s', (_label, plant, reason) => {
    const b = machineB()
    b.fs.mkdirp(projectDir(b))
    const file = ownedPaths(b.layout).observationFile(null, PROJECT_OBSERVATION)
    plant(b, file)
    const shown = `.darkmechanicus/observations/${PROJECT_OBSERVATION}.json`
    expect(importInto(b)).toEqual({ imported: [], rejected: [{ path: shown, message: `${shown} ${reason}.` }] })
  })

  it.each([
    { label: 'another observation id than its file name', folder: null, source: PROJECT_OBSERVATION, name: 'mo_01m7gg00000000000000000009', reason: 'names a different observation than its file name' },
    { label: 'an epic observation in the project folder', folder: null, source: EPIC_OBSERVATION, name: EPIC_OBSERVATION, reason: 'names an epic but sits in the project-level folder' },
    { label: 'a project observation in an epic folder', folder: EPIC, source: PROJECT_OBSERVATION, name: PROJECT_OBSERVATION, reason: 'belongs to a different epic' }
  ])('refuses $label', ({ folder, source, name, reason }) => {
    const texts = exportedTexts()
    const b = machineB()
    b.fs.put(ownedPaths(b.layout).observationFile(folder, name), texts.get(source) ?? '')
    const shown = `${folder === null ? '.darkmechanicus' : `.darkmechanicus/epics/${EPIC}`}/observations/${name}.json`
    expect(importInto(b)).toEqual({ imported: [], rejected: [{ path: shown, message: `${shown} ${reason}.` }] })
    expect(listObservations(b.db)).toEqual([])
  })
})
