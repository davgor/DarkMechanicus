// Regenerates src/main/desktop/ompBuiltinThemes.json from OMP's packages/tui/src/theme/defaults.json:
//   node scripts/omp-builtin-themes.mjs <path to defaults.json>
// Keeps, per built-in theme, only the colors the pane maps (docs/design/chat-shells.md, "Theme"), resolved to #rrggbb.
import { readFileSync, writeFileSync } from 'node:fs'

const KEYS = ['accent', 'selectedBg', 'text', 'error', 'success', 'warning', 'mdLink', 'muted']
const CUBE = [0, 95, 135, 175, 215, 255]
const hex = (r, g, b) => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')

function indexed(n) {
  if (n < 16) return ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'][n]
  if (n >= 232) return hex(...Array(3).fill(8 + (n - 232) * 10))
  const i = n - 16
  return hex(CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6])
}

function resolve(value, vars, depth = 0) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 255 ? indexed(value) : undefined
  if (typeof value !== 'string') return undefined
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase()
  return value in vars && depth < 8 ? resolve(vars[value], vars, depth + 1) : undefined
}

const defaults = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const out = {}
for (const name of Object.keys(defaults).sort()) {
  const { vars = {}, colors = {}, terminal = {} } = defaults[name]
  const entry = { colors: {}, terminal: {} }
  for (const key of KEYS) {
    const value = resolve(colors[key], vars)
    if (value !== undefined) entry.colors[key] = value
  }
  for (const key of ['background', 'foreground']) {
    const value = resolve(terminal[key], vars)
    if (value !== undefined) entry.terminal[key] = value
  }
  if (Array.isArray(terminal.ansi) && terminal.ansi.length === 16) {
    const ansi = terminal.ansi.map((value) => resolve(value, vars))
    if (ansi.every((value) => value !== undefined)) entry.terminal.ansi = ansi
  }
  out[name] = entry
}
writeFileSync(new URL('../src/main/desktop/ompBuiltinThemes.json', import.meta.url), JSON.stringify(out) + '\n')
console.log(`${Object.keys(out).length} themes`)
