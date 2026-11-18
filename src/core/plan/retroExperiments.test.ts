import { describe, expect, it } from 'vitest'
import { contentHash, prettyJson } from '../canonical'
import { getCheckpoint } from '../services/checkpoints'
import { retroSections } from '../../renderer/src/checkpoint/retroView'
import type { SprintRetro, SprintRetroInput } from '../../shared/domain/retro'
import { makeBundle, tid } from '../../test/bundles'
import { delivered, fixture, submit, validExperiment } from '../../test/experimentWorld'
import { normalizeRetro, retroIsEmpty, retroSearchParts } from './retro'

interface Legacy {
  name: string
  input: SprintRetroInput
  stored: SprintRetro
  contentHash: string
}

/** Prose retros as stored, with report hashes computed by the code before experiments existed (commit a417096). */
const LEGACY = fixture<{ reports: Legacy[] }>('legacy-retros.json', {}).reports
const FULL = LEGACY.find((item) => item.name === 'full prose retro') as Legacy

/** The report content the fixture's hashes were computed over. */
const reportOf = (retro: SprintRetro) => ({
  summary: 'Sprint 1 is over.',
  accepted: [],
  failed: [],
  blocked: [],
  changes: { files: [], commits: [] },
  checks: [],
  risks: [],
  followUps: [],
  exitCriteria: [],
  epicOutcome: null,
  retro
})

const KEYS = new Map([1, 2, 3, 4].map((n) => [tid(n), `DM-${n}`]))
const lookup = { ref: (ticketId: string) => ({ ticketId, key: KEYS.get(ticketId) ?? ticketId, title: '' }), accepted: () => false }
const keyOf = (ticketId: string): string => KEYS.get(ticketId) ?? ticketId

describe('DM-184 c2: legacy prose retros keep their serialized form and hash', () => {
  it.each(LEGACY.map((item) => [item.name, item] as const))('normalizes the %s to the bytes stored before experiments, with no experiments key', (_name, legacy) => {
    const stored = normalizeRetro(legacy.input, makeBundle([[1, 2, 3]]))
    expect(prettyJson(stored)).toBe(prettyJson(legacy.stored))
    expect('experiments' in stored).toBe(false)
    expect(contentHash(reportOf(stored))).toBe(legacy.contentHash)
  })

  it.each(LEGACY.map((item) => [item.name, item] as const))('submits the %s with the content hash it had before experiments', (_name, legacy) => {
    const w = delivered()
    expect(submit(w, { summary: 'Sprint 1 is over.', retro: legacy.input }).contentHash).toBe(legacy.contentHash)
  })
})

describe('DM-184 c2: rendering and search of a legacy retro', () => {
  it('renders every prose section of a legacy report as before, and an added experiment only in its own section', () => {
    const w = delivered()
    const legacy = submit(w, { summary: 'Sprint 1 is over.', retro: FULL.input })
    const withExperiment = submit(w, { summary: 'Sprint 1 is over.', retro: { ...FULL.input, experiments: [validExperiment(w)] } })
    const before = retroSections(legacy, lookup)
    const after = retroSections(withExperiment, lookup)
    expect(before?.actions).toEqual(['Size importer tickets larger'])
    expect(before?.discoveries.map((item) => item.title)).toEqual(['Index the scorecard', 'Untracked idea'])
    expect(before?.experiments).toEqual([])
    expect(after?.experiments).toHaveLength(1)
    expect({ ...after, experiments: [] }).toEqual(before)
  })

  it('keeps the search text of a legacy retro, an experiment only appending its own text', () => {
    const w = delivered()
    const withExperiment = submit(w, { summary: 'Sprint 1 is over.', retro: { ...FULL.input, experiments: [validExperiment(w)] } }).report.retro as SprintRetro
    const legacyParts = retroSearchParts(FULL.stored, keyOf)
    expect(legacyParts.slice(0, 3)).toEqual(['DM-1', 'Open the scorecard tab', 'screenshot attached'])
    const parts = retroSearchParts(withExperiment, keyOf)
    expect(parts.slice(0, legacyParts.length)).toEqual(legacyParts)
    expect(parts.slice(legacyParts.length)).toEqual([
      'Sprint 1 took 70 minutes of active time across three medium tickets.',
      'Hypothesis: the tickets were sized without the importer context, so workers re-read it each time.',
      'Add an importer context note to the planner skill',
      "Add one paragraph to the planner skill naming the importer's record files."
    ])
  })
})

describe('DM-184 c2: an empty experiments list never makes an empty retro count', () => {
  const bundle = makeBundle([[1, 2, 3]])

  it('normalizes { experiments: [] } to exactly the empty retro, which stays empty', () => {
    const empty = normalizeRetro({}, bundle)
    const listed = normalizeRetro({ experiments: [] }, bundle)
    expect(prettyJson(listed)).toBe(prettyJson(empty))
    expect(retroIsEmpty(listed)).toBe(true)
    expect(retroIsEmpty({ ...empty, experiments: [] })).toBe(true)
  })

  it('counts a prose entry or an experiment as a retro', () => {
    const w = delivered()
    expect(retroIsEmpty(normalizeRetro({ actions: ['Keep reviews short'] }, bundle))).toBe(false)
    const stored = submit(w, { summary: 'Sprint 1 is over.', retro: { experiments: [validExperiment(w)] } }).report.retro as SprintRetro
    expect(retroIsEmpty(stored)).toBe(false)
    expect(retroIsEmpty({ ...stored, experiments: [] })).toBe(true)
  })

  it('leaves the checkpoint retro gate unmet for a report sent with only experiments: [], and meets it with prose', () => {
    const w = delivered()
    const gate = () => getCheckpoint(w.ctx, { runId: w.runId }).conditions.find((condition) => condition.id === 'retro')
    submit(w, { summary: 'Sprint 1 is over.', retro: { experiments: [] } })
    expect(gate()).toMatchObject({ met: false, detail: "The Sprint 1 report's retro is empty" })
    submit(w, { summary: 'Sprint 1 is over.', retro: { actions: ['Keep reviews short'] } })
    expect(gate()?.met).toBe(true)
  })
})
