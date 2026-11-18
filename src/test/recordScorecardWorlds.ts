/**
 * Rewrites the recorded Scorecard worlds the renderer tests replay, one pretty-printed file per world. Run from the
 * repository root:
 *   npx tsx src/test/recordScorecardWorlds.ts
 * See scorecardWorldRecorder.ts for what each world holds. Not shipped.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { recordScorecardWorlds, WORLD_NAMES } from './scorecardWorldRecorder'

const WORLDS_DIR = resolve('src/renderer/src/__mocks__/scorecardWorlds')

async function main(): Promise<void> {
  const worlds = await recordScorecardWorlds()
  mkdirSync(WORLDS_DIR, { recursive: true })
  for (const name of WORLD_NAMES) {
    writeFileSync(join(WORLDS_DIR, `${name}.json`), `${JSON.stringify(worlds[name], null, 2)}\n`)
  }
  console.log(`Recorded ${WORLD_NAMES.length} worlds into ${WORLDS_DIR}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
