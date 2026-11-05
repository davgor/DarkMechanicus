import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_COLOR } from '../../shared/agents/terminalColors'
import { createOmpThemeHandlers, darkThemeName, ompAgentDir, readOmpTerminalTheme } from './ompTheme'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omp-theme-'))
  mkdirSync(join(dir, 'themes'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const config = (text: string): void => writeFileSync(join(dir, 'config.yml'), text)
const theme = (name: string, body: unknown): void => writeFileSync(join(dir, 'themes', `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body))

const ANSI = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`)
const VALID = {
  name: 'skitarii',
  vars: { rust: '#b7410e', steel: 244 },
  colors: { accent: 'rust', selectedBg: '#222222', text: '', error: '#ff0000', success: '#00ff00', warning: '#ffff00', mdLink: '#0000ff', muted: 'steel' },
  terminal: { background: '#101010', foreground: '#eeeeee', ansi: ANSI }
}

describe('readOmpTerminalTheme', () => {
  it('returns the colors of the theme config.yml names in theme.dark', () => {
    config('theme:\n  dark: skitarii\n  light: light\n')
    theme('skitarii', VALID)

    expect(readOmpTerminalTheme(dir)).toEqual({
      background: '#101010',
      foreground: '#eeeeee',
      cursor: '#b7410e',
      cursorAccent: '#101010',
      selectionBackground: '#222222',
      black: '#000000',
      red: '#000001',
      green: '#000002',
      yellow: '#000003',
      blue: '#000004',
      magenta: '#000005',
      cyan: '#000006',
      white: '#000007',
      brightBlack: '#000008',
      brightRed: '#000009',
      brightGreen: '#00000a',
      brightYellow: '#00000b',
      brightBlue: '#00000c',
      brightMagenta: '#00000d',
      brightCyan: '#00000e',
      brightWhite: '#00000f'
    })
  })

  it('derives the ANSI colors from the UI roles when the theme has no terminal block, and leaves the background to the app', () => {
    config('theme.dark: "roles"\n')
    theme('roles', { ...VALID, terminal: undefined })

    const colors = readOmpTerminalTheme(dir)

    expect(colors).toEqual({
      cursor: '#b7410e',
      selectionBackground: '#222222',
      red: '#ff0000',
      green: '#00ff00',
      yellow: '#ffff00',
      blue: '#0000ff',
      brightRed: '#ff0000',
      brightGreen: '#00ff00',
      brightYellow: '#ffff00',
      brightBlue: '#0000ff',
      // 256-color index 244 is the gray ramp.
      brightBlack: '#808080'
    })
    expect(colors?.background).toBeUndefined()
  })

})

describe('readOmpTerminalTheme for built-in themes', () => {
  it('uses the bundled colors of a built-in theme, which has no file, and of titanium when config.yml is missing', () => {
    config('theme:\n  dark: dark-nord\n')
    const nord = readOmpTerminalTheme(dir)
    expect(nord?.background).toMatch(TERMINAL_COLOR)
    expect(Object.keys(nord ?? {})).toHaveLength(21)

    rmSync(join(dir, 'config.yml'))
    const titanium = readOmpTerminalTheme(dir)
    expect(titanium?.background).toBe('#151820')
    expect(titanium?.cursor).toBe('#00b4ff')
  })

  it('prefers a built-in theme over a same-named file', () => {
    config('theme:\n  dark: titanium\n')
    theme('titanium', VALID)

    expect(readOmpTerminalTheme(dir)?.background).toBe('#151820')
  })

})

describe('readOmpTerminalTheme for a missing or malformed theme', () => {
  it('returns null for a theme file that is missing', () => {
    config('theme:\n  dark: nope\n')

    expect(readOmpTerminalTheme(dir)).toBeNull()
  })

  it.each([
    ['not JSON', '{ "colors": '],
    ['not an object', '[1, 2]'],
    ['colors of the wrong type', { colors: { accent: { r: 1 } } }],
    ['a terminal ansi list of the wrong length', { terminal: { ansi: ['#000000'] } }],
    ['an empty theme', {}]
  ])('returns null for a malformed theme file: %s', (_why, body) => {
    config('theme:\n  dark: bad\n')
    theme('bad', body)

    expect(readOmpTerminalTheme(dir)).toBeNull()
  })

})

describe('readOmpTerminalTheme for non-color values', () => {
  it.each([
    ['a CSS function', { terminal: { background: 'url(https://example.com/x)' } }],
    ['a color name', { colors: { accent: 'red' } }],
    ['a short hex', { colors: { accent: '#fff' } }],
    ['an out-of-range index', { colors: { accent: 300 } }],
    ['a vars name that is not defined', { colors: { accent: 'missing' } }],
    ['a vars cycle', { vars: { a: 'b', b: 'a' }, colors: { accent: 'a' } }],
    ['a color after a valid one', { terminal: { background: '#101010', foreground: 'expression(x)' } }]
  ])('returns null for a theme with non-color values: %s', (_why, body) => {
    config('theme:\n  dark: bad\n')
    theme('bad', body)

    expect(readOmpTerminalTheme(dir)).toBeNull()
  })

})

describe('readOmpTerminalTheme for theme names and sizes', () => {
  it.each(['..', '../outside', 'a/b', 'a\\\\b', '..\\\\x', '.hidden', 'a'.repeat(65)])('does not read a file for the theme name %j', (name) => {
    writeFileSync(join(dir, 'outside.json'), JSON.stringify(VALID))
    config(`theme:\n  dark: "${name}"\n`)

    expect(readOmpTerminalTheme(dir)).toBeNull()
  })

  it('takes the default theme when the agent folder does not exist, and returns null for a config.yml too large to read', () => {
    expect(readOmpTerminalTheme(join(dir, 'absent'))?.background).toBe('#151820')

    config(`theme:\n  dark: skitarii\n${'# pad\n'.repeat(60_000)}`)
    theme('skitarii', VALID)
    expect(readOmpTerminalTheme(dir)).toBeNull()
  })
})

describe('darkThemeName', () => {
  it.each([
    ['nested', 'theme:\n  dark: a\n  light: b\n', 'a'],
    ['nested, indented with tabs, quoted and commented', "other: 1\ntheme:\n\tdark: 'a-b' # note\n", 'a-b'],
    ['flat', 'theme.dark: a\n', 'a'],
    ['after other keys, with CRLF', 'shellPath: C:\\bash.exe\r\ntheme:\r\n  dark: a\r\n', 'a'],
    ['only the light slot', 'theme:\n  light: b\n', null],
    ['a dark key under another section', 'tools:\n  dark: a\n', null],
    ['a theme section that ended', 'theme:\n  light: b\nother:\n  dark: a\n', null],
    ['an empty value', 'theme:\n  dark:\n', null],
    ['nothing', '', null]
  ])('reads %s', (_why, yaml, expected) => {
    expect(darkThemeName(yaml)).toBe(expected)
  })
})

describe('ompAgentDir and the handler', () => {
  it('follows PI_CODING_AGENT_DIR as OMP does, and defaults to ~/.omp/agent', () => {
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: '/scratch/agent' }, '/home/x')).toBe('/scratch/agent')
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: '' }, '/home/x')).toBe(join('/home/x', '.omp', 'agent'))
    expect(ompAgentDir({}, '/home/x')).toBe(join('/home/x', '.omp', 'agent'))
  })

  it('answers each call from the files as they are then', async () => {
    const handlers = createOmpThemeHandlers({ agentDir: () => dir })
    config('theme:\n  dark: skitarii\n')
    expect(await handlers.ompTerminalTheme()).toBeNull()

    theme('skitarii', VALID)
    expect((await handlers.ompTerminalTheme())?.background).toBe('#101010')
  })
})
