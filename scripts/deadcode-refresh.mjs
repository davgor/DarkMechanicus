/**
 * Rewrite .tsprune-ignore from current dead exports: those dead in every scanned project that includes their file,
 * so a shared export one project uses never lands in the baseline.
 * Use after intentional export moves/deletes so `npm run deadcode` stays green.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baselineKey, collectDeadExports } from './deadcode-check.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IGNORE_PATH = join(ROOT, '.tsprune-ignore')

function main() {
  const lines = [...new Set(collectDeadExports().map(baselineKey))].sort()
  const header = [
    '# Baseline ignore for ts-prune: one `file - export` per line (line numbers are not matched)',
    '# Generated from tsconfig.node.json + tsconfig.web.json',
    '# Refresh after export moves/deletes: npm run deadcode:refresh',
    `# Refreshed ${new Date().toISOString().slice(0, 10)} (${lines.length} entries)`,
    ''
  ]
  writeFileSync(IGNORE_PATH, `${header.concat(lines).join('\n')}\n`, 'utf8')
  console.log(`Wrote ${lines.length} entries to .tsprune-ignore`)
}

main()
