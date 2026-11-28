/**
 * Inventory/contract tests: `npm run test:contracts [-- <vitest args>]`.
 *
 * Each test below asserts an exact list (commands, capabilities, MCP tools per role, IPC channels, preload API,
 * schemas, recorded fixtures) or a shared read-model shape. They live far from the code a ticket changes, so a
 * targeted run never selects them; run this set for any ticket touching commands, capabilities, MCP tools,
 * IPC/preload, RunView/read models or shared domain types. This list is the single place the set is named.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const CONTRACT_TESTS = [
  'src/mcp/roles.test.ts',
  'src/mcp/skills.test.ts',
  'src/core/authz.test.ts',
  'src/core/commands/capabilities.test.ts',
  'src/core/schemas.test.ts',
  'src/main/desktop/ipc.test.ts',
  'src/preload/index.test.ts',
  'src/test/scorecardWorldRecorder.test.ts',
  'src/core/services/runs.test.ts'
]

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  const run = spawnSync(process.execPath, [vitest, 'run', ...CONTRACT_TESTS, ...process.argv.slice(2)], { cwd: ROOT, stdio: 'inherit' })
  process.exit(run.status ?? 1)
}
