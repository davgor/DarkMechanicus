/**
 * The colors of OMP's active theme, for the pane of an OMP chat (`docs/design/chat-shells.md`, "Theme"; format and
 * location: `docs/reports/omp-cli.md`, 8 and 10). Main reads two things under OMP's agent folder and nothing else:
 * `config.yml`, for the name in `theme.dark`, and, for a name that is not one of OMP's built-in themes, the one file
 * `themes/<name>.json`. The renderer sends no path and no name; whatever fails to read or parse, or holds a value
 * that is not a color, makes the answer null and the pane keeps the app's palette.
 *
 * The slot is `theme.dark` (default `titanium`): OMP picks `theme.dark` or `theme.light` by the terminal's background,
 * and the app's pane is dark. The per-chat `--config` overlay the app passes sets both slots to `skitarii`
 * (`terminals/ompSkitariiTheme.ts`), so the handler asks for the bundled copy of that theme, which needs no file; with no name given the reader follows the person's own `config.yml`, as OMP would without the overlay.
 *
 * Built-in themes are compiled into omp.exe, so there is no file to read for them: `ompBuiltinThemes.json` holds the
 * few colors the mapping below needs, per built-in theme (`scripts/omp-builtin-themes.mjs` regenerates it from OMP).
 *
 * The mapping, key by key (a key whose source is missing or `""` is left to the app's palette):
 * - background, cursorAccent: `terminal.background`; foreground: `terminal.foreground`, else `colors.text`.
 * - cursor: `colors.accent`; selectionBackground: `colors.selectedBg`.
 * - the 16 ANSI colors: `terminal.ansi`; without it, red/green/yellow/blue (and bright) from `colors.error`,
 *   `success`, `warning`, `mdLink`, brightBlack from `muted`, white and brightWhite from the foreground.
 * `terminal` is the theme's optional block for hosts that paint the terminal themselves; OMP draws its own
 * true-color text on whatever background the terminal has, so only these terminal-level colors can show.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { TERMINAL_COLOR, type TerminalColorKey, type TerminalColors } from '../../shared/agents/terminalColors'
import { skitariiThemeFile } from '../terminals/ompSkitariiTheme'
import bundledThemes from './ompBuiltinThemes.json'

const DEFAULT_OMP_DARK_THEME = 'titanium'
/** The generator's header field (upstream source and license), not a theme. */
const SOURCE_FIELD = '_source'
const builtinThemes = Object.fromEntries(
  Object.entries(bundledThemes).filter(([name]) => name !== SOURCE_FIELD)
) as Record<string, ThemeFile>
/** OMP's config and theme files are small; anything larger is not read. */
const MAX_FILE_BYTES = 256 * 1024
const THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const satisfies readonly TerminalColorKey[]

const colorValue = z.union([z.string(), z.int().min(0).max(255)])
const themeFileSchema = z.object({
  vars: z.record(z.string(), colorValue).optional(),
  colors: z.record(z.string(), colorValue).optional(),
  terminal: z
    .object({ background: colorValue.optional(), foreground: colorValue.optional(), ansi: z.array(colorValue).length(16).optional() })
    .optional()
})

/** A theme as the mapping reads it: values as the file wrote them (`#rrggbb`, 0-255, a vars name or ""). */
type ThemeFile = z.infer<typeof themeFileSchema>

const CUBE = [0, 95, 135, 175, 215, 255]
const SYSTEM = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'
]
const hex = (channels: number[]): string => `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`

/** xterm's 256-color table entry `n` (0-255). */
function indexed(n: number): string {
  if (n < 16) return SYSTEM[n] ?? '#000000'
  if (n >= 232) {
    const level = 8 + (n - 232) * 10
    return hex([level, level, level])
  }
  const i = n - 16
  return hex([CUBE[Math.floor(i / 36)] ?? 0, CUBE[Math.floor(i / 6) % 6] ?? 0, CUBE[i % 6] ?? 0])
}

/** A color value as `#rrggbb`; undefined for "" (the terminal's default); throws for anything that is not a color. */
function resolve(value: string | number | undefined, vars: Record<string, string | number>, depth = 0): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value === 'number') return indexed(value)
  if (TERMINAL_COLOR.test(value)) return value.toLowerCase()
  const named = Object.hasOwn(vars, value) ? vars[value] : undefined
  if (named === undefined || depth > 8) throw new Error(`${value} is not a color`)
  return resolve(named, vars, depth + 1)
}

/** The mapping (see the file comment). */
function mapTheme(file: ThemeFile): TerminalColors {
  const vars = file.vars ?? {}
  const color = (value: string | number | undefined): string | undefined => resolve(value, vars)
  const { colors = {}, terminal = {} } = file
  const background = color(terminal.background)
  const foreground = color(terminal.foreground) ?? color(colors['text'])
  const ansi = terminal.ansi?.map((value) => color(value))
  const derived: Partial<Record<TerminalColorKey, string | undefined>> = {
    red: color(colors['error']),
    green: color(colors['success']),
    yellow: color(colors['warning']),
    blue: color(colors['mdLink']),
    brightBlack: color(colors['muted']),
    white: foreground,
    brightWhite: foreground
  }
  derived.brightRed = derived.red
  derived.brightGreen = derived.green
  derived.brightYellow = derived.yellow
  derived.brightBlue = derived.blue
  const out: Partial<Record<TerminalColorKey, string | undefined>> = {
    background,
    foreground,
    cursor: color(colors['accent']),
    cursorAccent: background,
    selectionBackground: color(colors['selectedBg'])
  }
  ANSI.forEach((name, index) => {
    out[name] = ansi === undefined ? derived[name] : ansi[index]
  })
  return Object.fromEntries(Object.entries(out).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function unquote(value: string): string | null {
  const bare = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value
  return bare === '' ? null : bare
}

/** The name in `theme.dark` of a `config.yml`, or null: nested (`theme:` then `  dark: name`) or flat (`theme.dark: name`). */
export function darkThemeName(yaml: string): string | null {
  let section = ''
  for (const raw of yaml.split(/\r?\n/)) {
    const match = /^(\s*)([\w.]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/\s+#.*$/, ''))
    if (match === null) continue
    const [, indent = '', key = '', value = ''] = match
    // A top-level key with no value opens a section; the keys indented under it are its children.
    if (indent === '') section = value === '' ? key : ''
    if ((indent === '' ? key : `${section}.${key}`) === 'theme.dark') return unquote(value)
  }
  return null
}

function readSmall(file: string): string {
  if (statSync(file).size > MAX_FILE_BYTES) throw new Error('too large')
  return readFileSync(file, 'utf8')
}

/** OMP's agent folder: `$PI_CODING_AGENT_DIR` (as OMP honours it), else `~/.omp/agent`. */
export function ompAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const set = env['PI_CODING_AGENT_DIR']
  return set !== undefined && set !== '' ? set : join(home, '.omp', 'agent')
}

/** The name in the person's `config.yml` `theme.dark`, else the default; throws when the file cannot be read (a missing one is a default install). */
function configuredThemeName(agentDir: string): string {
  try {
    return darkThemeName(readSmall(join(agentDir, 'config.yml'))) ?? DEFAULT_OMP_DARK_THEME
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_OMP_DARK_THEME
    throw error
  }
}

/** The theme file for `name`: a built-in's bundled colors, or the one file in the themes folder. */
function themeFor(agentDir: string, name: string): ThemeFile {
  if (!THEME_NAME.test(name) || name.includes('..')) throw new Error('not a theme name')
  return Object.hasOwn(builtinThemes, name)
    ? builtinThemes[name] ?? {}
    : themeFileSchema.parse(JSON.parse(readSmall(join(agentDir, 'themes', `${name}.json`))))
}

/**
 * The colors of OMP's active theme from the agent folder, or null when there is none to show (see the file comment).
 * `skitarii` asks for the bundled Skitarii theme instead, which an app chat is launched with and which needs no file.
 */
export function readOmpTerminalTheme(agentDir: string, skitarii = false): TerminalColors | null {
  try {
    const file = skitarii ? themeFileSchema.parse(skitariiThemeFile) : themeFor(agentDir, configuredThemeName(agentDir))
    const colors = mapTheme(file)
    return Object.keys(colors).length === 0 ? null : colors
  } catch {
    return null
  }
}

export interface OmpThemeHandlers {
  ompTerminalTheme(): Promise<TerminalColors | null>
}

/** `dm.ompTerminalTheme()`: takes nothing, reads each time it is asked (when an OMP chat is opened). */
export function createOmpThemeHandlers(deps: { agentDir?: () => string } = {}): OmpThemeHandlers {
  const agentDir = deps.agentDir ?? ompAgentDir
  return { ompTerminalTheme: async () => readOmpTerminalTheme(agentDir(), true) }
}
