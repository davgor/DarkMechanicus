import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SKILLS_VERSION } from '../core/version'
import { recordScorecardWorlds, WORLD_NAMES } from './scorecardWorldRecorder'

// Recorded state stays fixed; build provenance follows the version used by a fresh run.
const stored = (name: string): unknown => JSON.parse(
  readFileSync(new URL(`../renderer/src/__mocks__/scorecardWorlds/${name}.json`, import.meta.url), 'utf8'),
  (key, value: unknown) => key === 'skillVersion' ? SKILLS_VERSION : value
)

describe('DM-272: the recorded Scorecard worlds match the core read models', () => {
  it('records every world afresh exactly as the checked-in files hold it', async () => {
    const fresh = await recordScorecardWorlds()
    for (const name of WORLD_NAMES) {
      expect(stored(name), name).toEqual(fresh[name])
    }
  })
})
