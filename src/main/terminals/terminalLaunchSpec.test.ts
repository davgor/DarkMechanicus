/**
 * What main starts in a chat's terminal, as a pure function of its own records: the program, its arguments (or,
 * on Windows, the command line the app builds), the folder and the environment. A table over every kind, new and
 * resumed, on macOS and Windows; then the rules each row relies on: whole-argument placeholders, the scrubbed
 * environment, Windows shims, and the values that are dropped rather than passed.
 */
import { describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { transferGuidance } from '../../mcp/transferKickoff'
import { kanbanGuidance } from '../agents/kanbanKickoff'
import { orchestratorGuidance } from '../agents/orchestratorKickoff'
import { terminalInstructions } from './terminalFiles'
import { terminalLaunchSpec, type TerminalLaunchInput, type TerminalLaunchSpec } from './terminalLaunchSpec'
import { windowsCommandLine } from './windowsCommandLine'

type Kind = TerminalLaunchInput['agent']['kind']
type Platform = 'darwin' | 'win32'

const STORED_ID = '0b6f6c1e-3c58-4f8e-9a0b-3d2f4b7c9e11'
const NEW_ID = '7d1c2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const KICKOFF = 'Run the epic "Terminal chats" now.'

const MAC = {
  folder: '/Users/me/My Repo',
  instructions: '/Users/me/Library/Application Support/Dark Mechanicus/agents/instructions/ch_1.md',
  launcherDir: '/Users/me/Library/Application Support/Dark Mechanicus/agents/bin/ch_1',
  settings: '/Users/me/Library/Application Support/Dark Mechanicus/agents/settings/ch_1.json',
  env: { PATH: '/usr/bin:/bin', HOME: '/Users/me', TERM: 'dumb', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', NODE_OPTIONS: '--inspect' },
  executables: {
    claude: '/Users/me/.local/bin/claude',
    autonomous: '/Users/me/.local/bin/a8s',
    codex: '/opt/homebrew/bin/codex',
    cursor: '/Users/me/.local/bin/agent',
    custom: '/Users/me/bin/my agent'
  } satisfies Record<Kind, string>
}

const WIN = {
  folder: 'C:\\Users\\me\\My Repo',
  instructions: 'C:\\Users\\me\\AppData\\Roaming\\Dark Mechanicus\\agents\\instructions\\ch_1.md',
  settings: 'C:\\Users\\me\\AppData\\Roaming\\Dark Mechanicus\\agents\\settings\\ch_1.json',
  env: { Path: 'C:\\Windows', SystemRoot: 'D:\\Windows', ELECTRON_RUN_AS_NODE: '1', electron_no_attach_console: '1', Node_Options: '--inspect' },
  executables: {
    claude: 'C:\\Users\\me\\.local\\bin\\claude.exe',
    autonomous: 'C:\\Users\\me\\.local\\bin\\a8s.exe',
    codex: 'C:\\Tools\\codex.exe',
    cursor: 'C:\\Tools\\agent.exe',
    custom: 'C:\\Tools\\my agent.exe'
  } satisfies Record<Kind, string>
}

const CUSTOM_ARGS = ['--cwd', '{folder}', '--prompt-file', '{instructions}', '--verbose']

function cliFor(platform: Platform, packaged = true): DarkMechanicusCli {
  const folder = platform === 'win32' ? WIN.folder : MAC.folder
  const runtime = platform === 'win32' ? 'C:\\Program Files\\Dark Mechanicus\\Dark Mechanicus.exe' : '/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus'
  return {
    command: runtime,
    args: [platform === 'win32' ? 'C:\\Program Files\\Dark Mechanicus\\resources\\app.asar\\out\\main\\cli.js' : '/Applications/Dark Mechanicus.app/Contents/Resources/app.asar/out/main/cli.js', '--repo', folder],
    env: { ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}), DARKMECHANICUS_HOME: '/Users/me/.darkmechanicus', DM_SESSION_TOKEN: 'grant-token-ch_1' }
  }
}

function inputFor(kind: Kind, platform: Platform, state: 'new' | 'resumed', overrides: Partial<TerminalLaunchInput> = {}): TerminalLaunchInput {
  const at = platform === 'win32' ? WIN : MAC
  const resumed = state === 'resumed'
  return {
    chat: { agent: kind === 'custom' ? 'cu_01' : kind, role: 'orchestrator', allowSave: false, model: 'haiku', sessionId: STORED_ID, sessionStarted: resumed, kickoffSent: resumed },
    kickoff: KICKOFF,
    agent: { id: kind === 'custom' ? 'cu_01' : kind, kind, executablePath: at.executables[kind], args: kind === 'custom' ? CUSTOM_ARGS : [] },
    folder: at.folder,
    cli: cliFor(platform),
    files: { instructions: at.instructions, launcherDir: platform === 'win32' ? null : MAC.launcherDir },
    platform,
    env: at.env,
    newSessionId: () => NEW_ID,
    ...overrides
  }
}

function instructionsText(platform: Platform, orchestratesRun = false): string {
  return terminalInstructions({ cli: cliFor(platform), role: 'orchestrator', allowSave: false, launcherDir: platform === 'win32' ? null : MAC.launcherDir, orchestratesRun })
}

/** What each kind is started with on a new and a resumed chat, given the folder, the instructions file and their text. */
function expectedArgs(kind: Kind, state: 'new' | 'resumed', at: { folder: string; instructions: string; text: string }): string[] {
  const rows: Record<Kind, Record<'new' | 'resumed', string[]>> = {
    claude: {
      new: ['--append-system-prompt-file', at.instructions, '--model', 'haiku', '--session-id', STORED_ID, KICKOFF],
      resumed: ['--append-system-prompt-file', at.instructions, '--model', 'haiku', '--resume', STORED_ID]
    },
    autonomous: {
      new: ['start', at.folder, '--append-system-prompt', at.text, '--approval-mode', 'always-ask', '--model', 'haiku'],
      resumed: ['resume', '--append-system-prompt', at.text, '--approval-mode', 'always-ask', '--model', 'haiku']
    },
    codex: { new: ['-C', at.folder, '-m', 'haiku'], resumed: ['resume', STORED_ID, '-m', 'haiku'] },
    cursor: { new: ['-m', 'haiku'], resumed: ['--resume', STORED_ID, '-m', 'haiku'] },
    custom: {
      new: ['--cwd', at.folder, '--prompt-file', at.instructions, '--verbose'],
      resumed: ['--cwd', at.folder, '--prompt-file', at.instructions, '--verbose']
    }
  }
  return rows[kind][state]
}

/** What is pasted once the CLI is ready: what cannot go on its command line. */
function expectedPaste(kind: Kind, state: 'new' | 'resumed', text: string): string | null {
  if (state === 'resumed' || kind === 'claude') {
    return null
  }
  return kind === 'codex' || kind === 'cursor' ? `${text}\n\n${KICKOFF}` : KICKOFF
}

const COMMON_ENV = ['COLORTERM', 'DARKMECHANICUS_HOME', 'DM_SESSION_TOKEN', 'TERM']
const MAC_ENV = [...COMMON_ENV, 'HOME', 'PATH']
const WIN_ENV = [...COMMON_ENV, 'ELECTRON_RUN_AS_NODE', 'Path', 'SystemRoot']

const KINDS: Kind[] = ['claude', 'autonomous', 'codex', 'cursor', 'custom']
const TABLE = KINDS.flatMap((kind) => (['new', 'resumed'] as const).flatMap((state) => (['darwin', 'win32'] as const).map((platform) => ({ kind, state, platform }))))

function argsOf(spec: TerminalLaunchSpec): string[] {
  if (!('args' in spec) || spec.args === undefined) {
    throw new Error('expected an argv launch')
  }
  return spec.args
}

function lineOf(spec: TerminalLaunchSpec): string {
  if (!('commandLine' in spec) || spec.commandLine === undefined) {
    throw new Error('expected a command-line launch')
  }
  return spec.commandLine
}

describe('terminalLaunchSpec: every kind, new and resumed, on macOS and Windows', () => {
  it.each(TABLE)('$kind, $state, $platform', ({ kind, state, platform }) => {
    const at = platform === 'win32' ? WIN : MAC
    const spec = terminalLaunchSpec(inputFor(kind, platform, state))
    const args = expectedArgs(kind, state, { folder: at.folder, instructions: at.instructions, text: instructionsText(platform) })

    expect(spec.file).toBe(at.executables[kind])
    if (platform === 'win32') {
      expect(lineOf(spec)).toBe(windowsCommandLine(args))
    } else {
      expect(argsOf(spec)).toEqual(args)
    }
    expect(spec.cwd).toBe(at.folder)
    const envKeys = [...(platform === 'win32' ? WIN_ENV : MAC_ENV), ...(kind === 'claude' ? ['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] : [])]
    expect(Object.keys(spec.env).sort()).toEqual(envKeys.sort())
    expect(spec.pasteFirst).toBe(expectedPaste(kind, state, instructionsText(platform)))
    expect(spec.dropped).toEqual([])
  })
})

describe('terminalLaunchSpec: sessions and the kickoff', () => {
  it('reports the session the CLI runs under: Claude always, Codex and Cursor once resumed, Autonomous and custom never', () => {
    expect(terminalLaunchSpec(inputFor('claude', 'darwin', 'new')).sessionId).toBe(STORED_ID)
    expect(terminalLaunchSpec(inputFor('claude', 'darwin', 'resumed')).sessionId).toBe(STORED_ID)
    expect(terminalLaunchSpec(inputFor('codex', 'darwin', 'new')).sessionId).toBeNull()
    expect(terminalLaunchSpec(inputFor('cursor', 'darwin', 'resumed')).sessionId).toBe(STORED_ID)
    expect(terminalLaunchSpec(inputFor('autonomous', 'darwin', 'resumed')).sessionId).toBeNull()
    expect(terminalLaunchSpec(inputFor('custom', 'darwin', 'resumed')).sessionId).toBeNull()
  })

  it('says whether the launch resumes an earlier session: the kinds that resume, once started; never a custom CLI', () => {
    const kinds = ['claude', 'autonomous', 'codex', 'cursor', 'custom'] as const
    expect(kinds.map((kind) => [terminalLaunchSpec(inputFor(kind, 'darwin', 'new')).resumed, terminalLaunchSpec(inputFor(kind, 'darwin', 'resumed')).resumed])).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, false]
    ])
    const noId = inputFor('claude', 'darwin', 'resumed')
    expect(terminalLaunchSpec({ ...noId, chat: { ...noId.chat, sessionId: null } }).resumed).toBe(false)
  })

  it('starts a Claude chat with no session id yet on a session id main generates', () => {
    const spec = terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { chat: { ...inputFor('claude', 'darwin', 'new').chat, sessionId: null } }))

    expect(argsOf(spec)).toContain('--session-id')
    expect(argsOf(spec)[argsOf(spec).indexOf('--session-id') + 1]).toBe(NEW_ID)
    expect(spec.sessionId).toBe(NEW_ID)
    expect(spec.dropped).toEqual([])
  })

  it('passes the Claude settings file only when one is given', () => {
    const spec = terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { files: { instructions: MAC.instructions, launcherDir: MAC.launcherDir, claudeSettings: MAC.settings } }))

    expect(argsOf(spec).slice(0, 4)).toEqual(['--append-system-prompt-file', MAC.instructions, '--settings', MAC.settings])
    expect(argsOf(terminalLaunchSpec(inputFor('claude', 'darwin', 'new')))).not.toContain('--settings')
  })

  it('sends the kickoff only with a chat\'s first start: never after it was sent, never with a resume, and never when there is none', () => {
    const chat = inputFor('claude', 'darwin', 'new').chat

    expect(argsOf(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { chat: { ...chat, kickoffSent: true } })))).not.toContain(KICKOFF)
    expect(argsOf(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { chat: { ...chat, sessionStarted: true } })))).not.toContain(KICKOFF)
    expect(argsOf(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { kickoff: null })))).toEqual(expectedArgs('claude', 'new', { ...MAC, text: '' }).slice(0, -1))
    expect(terminalLaunchSpec(inputFor('autonomous', 'darwin', 'new', { kickoff: null })).pasteFirst).toBeNull()
    expect(terminalLaunchSpec(inputFor('cursor', 'darwin', 'new', { kickoff: null })).pasteFirst).toBe(instructionsText('darwin'))
  })

  it('refuses a kickoff a CLI would read as a flag or as a subcommand (a single word, such as Claude\'s purge)', () => {
    for (const kickoff of ['--dangerously-skip-permissions', '-p', 'purge', 'auth', '']) {
      expect(() => terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { kickoff }))).toThrow(/kickoff/)
    }
  })

  it('refuses an agent row that is not the chat\'s agent', () => {
    expect(() => terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { chat: { ...inputFor('claude', 'darwin', 'new').chat, agent: 'codex' } }))).toThrow(/agent/)
  })
})

describe('terminalLaunchSpec: the orchestrator chat Start run opened', () => {
  const runChat = (kind: Kind): TerminalLaunchInput['chat'] => ({ ...inputFor(kind, 'darwin', 'new').chat, runId: 'rn_2' })

  it('gives every CLI the guidance with its instructions: Claude its file, Autonomous its appended prompt, Codex and Cursor their first paste', () => {
    const withGuidance = instructionsText('darwin', true)
    expect(withGuidance.endsWith(orchestratorGuidance())).toBe(true)

    expect(argsOf(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { chat: runChat('claude') })))).toEqual(expectedArgs('claude', 'new', { ...MAC, text: '' }))
    expect(argsOf(terminalLaunchSpec(inputFor('autonomous', 'darwin', 'new', { chat: runChat('autonomous') })))).toEqual(expectedArgs('autonomous', 'new', { ...MAC, text: withGuidance }))
    expect(terminalLaunchSpec(inputFor('codex', 'darwin', 'new', { chat: runChat('codex') })).pasteFirst).toBe(`${withGuidance}\n\n${KICKOFF}`)
    expect(terminalLaunchSpec(inputFor('cursor', 'darwin', 'new', { chat: runChat('cursor') })).pasteFirst).toBe(`${withGuidance}\n\n${KICKOFF}`)
  })

  it('keeps the guidance off the command line of every other chat', () => {
    expect(argsOf(terminalLaunchSpec(inputFor('autonomous', 'darwin', 'new'))).join('\n')).not.toContain('=== Orchestrator guidance')
  })

  it('says how the kickoff goes with the start: on Claude\'s command line, in every other paste, or not at all', () => {
    const kinds = ['claude', 'autonomous', 'codex', 'cursor', 'custom'] as const
    const routes = (state: 'new' | 'resumed', overrides: Partial<TerminalLaunchInput> = {}): (string | null)[] =>
      kinds.map((kind) => terminalLaunchSpec(inputFor(kind, 'darwin', state, overrides)).kickoffIn)
    const sent = { ...inputFor('claude', 'darwin', 'new').chat, kickoffSent: true }

    expect(routes('new')).toEqual(['args', 'paste', 'paste', 'paste', 'paste'])
    expect(routes('resumed')).toEqual([null, null, null, null, null])
    expect(routes('new', { kickoff: null })).toEqual([null, null, null, null, null])
    expect(kinds.map((kind) => terminalLaunchSpec(inputFor(kind, 'darwin', 'new', { chat: { ...sent, agent: kind === 'custom' ? 'cu_01' : kind } })).kickoffIn)).toEqual([null, null, null, null, null])
    const shim = terminalLaunchSpec(inputFor('autonomous', 'win32', 'new', { agent: { id: 'autonomous', kind: 'autonomous', executablePath: A8S_SHIM, args: [] } }))
    expect(shim.kickoffIn).toBe('paste')
  })
})

describe('terminalLaunchSpec: the card chat Play opened and the Linear transfer chat', () => {
  const CARD_ID = 'kc_01m6a1p7qaxttbw9f5927qk2dx'
  const EPIC_ID = 'ep_01m6772ffwkwr2a91fsqzfz1he'
  const cardChat = (kind: Kind, platform: Platform = 'darwin'): TerminalLaunchInput['chat'] => ({ ...inputFor(kind, platform, 'new').chat, cardId: CARD_ID })
  const transferChat = (kind: Kind): TerminalLaunchInput['chat'] => ({ ...inputFor(kind, 'darwin', 'new').chat, transferEpicId: EPIC_ID })

  it("starts Claude Code on a card chat with its instructions file and the kickoff as its positional prompt, the card's task in neither argument", () => {
    const args = argsOf(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { chat: cardChat('claude') })))

    expect(args).toEqual(expectedArgs('claude', 'new', { ...MAC, text: '' }))
    expect(args.join('\n')).not.toContain('Carrying a Dark Mechanicus Kanban card')
  })

  it('gives every other CLI the card guidance with its instructions: Autonomous its appended prompt, Codex and Cursor their first paste, a .cmd its paste', () => {
    const mac = `${instructionsText('darwin')}\n\n${kanbanGuidance(CARD_ID)}`
    const win = `${instructionsText('win32')}\n\n${kanbanGuidance(CARD_ID)}`
    const shim = { id: 'autonomous', kind: 'autonomous' as const, executablePath: A8S_SHIM, args: [] }

    expect(argsOf(terminalLaunchSpec(inputFor('autonomous', 'darwin', 'new', { chat: cardChat('autonomous') })))).toEqual(expectedArgs('autonomous', 'new', { ...MAC, text: mac }))
    expect(terminalLaunchSpec(inputFor('codex', 'darwin', 'new', { chat: cardChat('codex') })).pasteFirst).toBe(`${mac}\n\n${KICKOFF}`)
    expect(terminalLaunchSpec(inputFor('cursor', 'darwin', 'new', { chat: cardChat('cursor') })).pasteFirst).toBe(`${mac}\n\n${KICKOFF}`)
    expect(terminalLaunchSpec(inputFor('autonomous', 'win32', 'new', { chat: cardChat('autonomous', 'win32'), agent: shim })).pasteFirst).toBe(`${win}\n\n${KICKOFF}`)
  })

  it('gives a card chat started again on a new Codex session its card, without the kickoff', () => {
    const again = { ...cardChat('codex'), kickoffSent: true }

    expect(terminalLaunchSpec(inputFor('codex', 'darwin', 'new', { chat: again })).pasteFirst).toBe(`${instructionsText('darwin')}\n\n${kanbanGuidance(CARD_ID)}`)
  })

  it('gives a transfer chat the transfer guidance with its instructions, and a plain chat neither guidance', () => {
    const transfer = `${instructionsText('darwin')}\n\n${transferGuidance(EPIC_ID)}`

    expect(terminalLaunchSpec(inputFor('codex', 'darwin', 'new', { chat: transferChat('codex') })).pasteFirst).toBe(`${transfer}\n\n${KICKOFF}`)
    expect(argsOf(terminalLaunchSpec(inputFor('autonomous', 'darwin', 'new', { chat: transferChat('autonomous') })))).toEqual(expectedArgs('autonomous', 'new', { ...MAC, text: transfer }))
    const plain = terminalLaunchSpec(inputFor('cursor', 'darwin', 'new')).pasteFirst ?? ''
    expect(plain).not.toContain('Carrying a Dark Mechanicus Kanban card')
    expect(plain).not.toContain('Linear transfer guidance')
  })
})

describe('terminalLaunchSpec: the folder', () => {
  it('replaces {folder} and {instructions} only as whole arguments', () => {
    const spec = terminalLaunchSpec(inputFor('custom', 'darwin', 'new'))

    expect(argsOf(spec)).toEqual(['--cwd', MAC.folder, '--prompt-file', MAC.instructions, '--verbose'])
  })

  it.each([['--dir={folder}'], ['{folder}/src'], ['--file={instructions}'], ['{instructions}.bak'], ['x{folder}{instructions}']])(
    'refuses %s, a placeholder inside a longer argument',
    (arg) => {
      expect(() => terminalLaunchSpec(inputFor('custom', 'darwin', 'new', { agent: { id: 'cu_01', kind: 'custom', executablePath: MAC.executables.custom, args: [arg] } }))).toThrow(
        /must be an argument of its own/
      )
    }
  )

  it('refuses a dm command pinned to any folder but the one the chat starts in', () => {
    const cli = { ...cliFor('darwin'), args: ['/cli.js', '--repo', '/Users/me/Other'] }

    expect(() => terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { cli }))).toThrow(/--repo/)
  })
})

describe('terminalLaunchSpec: the environment', () => {
  it('drops every Electron and Node switch of main, whatever its case, and sets the terminal and the chat grant', () => {
    for (const kind of KINDS) {
      for (const platform of ['darwin', 'win32'] as const) {
        const spec = terminalLaunchSpec(inputFor(kind, platform, 'new', { cli: cliFor(platform, false) }))

        expect(Object.keys(spec.env).filter((key) => /^(electron_|node_options$)/i.test(key))).toEqual([])
        expect(spec.env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', DM_SESSION_TOKEN: 'grant-token-ch_1', DARKMECHANICUS_HOME: '/Users/me/.darkmechanicus' })
      }
    }
  })

  it('keeps ELECTRON_RUN_AS_NODE=1 only for a packaged app on Windows; on macOS the launcher sets it for dm alone', () => {
    expect(terminalLaunchSpec(inputFor('claude', 'win32', 'new')).env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(terminalLaunchSpec(inputFor('claude', 'win32', 'new', { cli: cliFor('win32', false) })).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(terminalLaunchSpec(inputFor('claude', 'darwin', 'new')).env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('takes from the dm environment only the grant and the home, never anything else main put there', () => {
    const cli = { ...cliFor('darwin'), env: { ...cliFor('darwin').env, NODE_OPTIONS: '--require /x.js', EXTRA: '1' } }

    expect(terminalLaunchSpec(inputFor('cursor', 'darwin', 'new', { cli })).env).not.toHaveProperty('EXTRA')
    expect(terminalLaunchSpec(inputFor('cursor', 'darwin', 'new', { cli })).env).not.toHaveProperty('NODE_OPTIONS')
  })

  it('drops what main has under a name the terminal sets, in any letter case, so Windows never sees two of one variable', () => {
    const env = { ...WIN.env, term: 'dumb', Dm_Session_Token: 'stale-token', colorterm: 'no' }
    const spec = terminalLaunchSpec(inputFor('claude', 'win32', 'new', { env }))

    expect(Object.keys(spec.env).filter((key) => /^(term|colorterm|dm_session_token)$/i.test(key)).sort()).toEqual(['COLORTERM', 'DM_SESSION_TOKEN', 'TERM'])
    expect(spec.env['DM_SESSION_TOKEN']).toBe('grant-token-ch_1')
  })

  it('refuses to start without the chat grant', () => {
    const cli = { ...cliFor('darwin'), env: { DARKMECHANICUS_HOME: '/h' } }

    expect(() => terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { cli }))).toThrow(/DM_SESSION_TOKEN/)
  })

  it('puts the chat launcher folder first on the macOS PATH, and nowhere on Windows', () => {
    expect(terminalLaunchSpec(inputFor('claude', 'darwin', 'new')).env['PATH']).toBe(`${MAC.launcherDir}:/usr/bin:/bin`)
    expect(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { env: { HOME: '/Users/me' } })).env['PATH']).toBe(MAC.launcherDir)
    expect(terminalLaunchSpec(inputFor('claude', 'win32', 'new')).env['Path']).toBe('C:\\Windows')
  })

  it('leaves PATH as it is when the launcher folder holds a colon, which would split it; the instructions name the launcher by path', () => {
    const files = { instructions: MAC.instructions, launcherDir: '/Users/me/odd:name/bin/ch_1' }

    expect(terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { files })).env['PATH']).toBe('/usr/bin:/bin')
  })

  it('needs the launcher folder on macOS', () => {
    expect(() => terminalLaunchSpec(inputFor('claude', 'darwin', 'new', { files: { instructions: MAC.instructions, launcherDir: null } }))).toThrow(/launcher/)
  })
})

const A8S_SHIM = 'C:\\Users\\me\\AppData\\Roaming\\npm\\a8s.cmd'
const CMD = 'D:\\Windows\\System32\\cmd.exe'
const NATIVE_SHIM = 'endLocal & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'
const NPM_SHIM = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'

function shimFs(text: string, files: string[] = []): NonNullable<TerminalLaunchInput['shimFs']> {
  return { readFile: () => text, isFile: (path) => files.includes(path) }
}

describe('terminalLaunchSpec: Windows programs and the Autonomous shim', () => {
  it('quotes an .exe command line exactly as Node does', () => {
    const spec = terminalLaunchSpec(inputFor('claude', 'win32', 'new'))

    expect(spec.file).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(lineOf(spec)).toBe(
      `--append-system-prompt-file "${WIN.instructions}" --model haiku --session-id ${STORED_ID} "Run the epic \\"Terminal chats\\" now."`
    )
  })

  it('starts an Autonomous .cmd through the one cmd.exe parse, with the instructions and the kickoff pasted instead', () => {
    const spec = terminalLaunchSpec(inputFor('autonomous', 'win32', 'new', { agent: { id: 'autonomous', kind: 'autonomous', executablePath: A8S_SHIM, args: [] } }))

    expect(spec.file).toBe(CMD)
    expect(lineOf(spec)).toBe(`/d /v:off /s /c ""${A8S_SHIM}" start "${WIN.folder}" --approval-mode always-ask --model haiku"`)
    expect(spec.pasteFirst).toBe(`${instructionsText('win32')}\n\n${KICKOFF}`)
  })

  it('pastes nothing into a resumed Autonomous .cmd: the session has its instructions', () => {
    const spec = terminalLaunchSpec(inputFor('autonomous', 'win32', 'resumed', { agent: { id: 'autonomous', kind: 'autonomous', executablePath: A8S_SHIM, args: [] } }))

    expect(lineOf(spec)).toBe(`/d /v:off /s /c ""${A8S_SHIM}" resume --approval-mode always-ask --model haiku"`)
    expect(spec.pasteFirst).toBeNull()
  })
})

describe('terminalLaunchSpec: a Claude .cmd is followed to the program it runs', () => {
  it('follows a Claude .cmd to the program it runs, so the instructions file, the settings and the kickoff never pass through cmd.exe', () => {
    const files = { instructions: WIN.instructions, launcherDir: null, claudeSettings: WIN.settings }
    const spec = terminalLaunchSpec(
      inputFor('claude', 'win32', 'new', { agent: { id: 'claude', kind: 'claude', executablePath: 'C:\\npm\\claude.cmd', args: [] }, files, shimFs: shimFs(NATIVE_SHIM) })
    )

    expect(spec.file).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    expect(lineOf(spec)).toBe(
      windowsCommandLine(['--append-system-prompt-file', WIN.instructions, '--settings', WIN.settings, '--model', 'haiku', '--session-id', STORED_ID, KICKOFF])
    )
  })

  it('runs a Claude script behind an npm shim with the node.exe beside the shim, as the shim would, else the first node.exe on an absolute Path folder', () => {
    const agent = { id: 'claude', kind: 'claude' as const, executablePath: 'C:\\npm\\claude.cmd', args: [] }
    const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    const env = { ...WIN.env, Path: 'tools;C:\\Windows;C:\\Program Files\\nodejs\\;D:\\other' }
    const nodes = ['tools\\node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'D:\\other\\node.exe']
    const beside = terminalLaunchSpec(inputFor('claude', 'win32', 'resumed', { agent, env, shimFs: shimFs(NPM_SHIM, ['C:\\npm\\node.exe', ...nodes]) }))
    const onPath = terminalLaunchSpec(inputFor('claude', 'win32', 'resumed', { agent, env, shimFs: shimFs(NPM_SHIM, nodes) }))

    expect(beside.file).toBe('C:\\npm\\node.exe')
    expect(onPath.file).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(lineOf(beside)).toBe(windowsCommandLine([script, '--append-system-prompt-file', WIN.instructions, '--model', 'haiku', '--resume', STORED_ID]))
  })

  it('refuses a Claude script behind an npm shim when no node.exe can be found, with what to connect instead', () => {
    const agent = { id: 'claude', kind: 'claude' as const, executablePath: 'C:\\npm\\claude.cmd', args: [] }

    expect(() => terminalLaunchSpec(inputFor('claude', 'win32', 'new', { agent, shimFs: shimFs(NPM_SHIM, ['relative\\node.exe']) }))).toThrow(/Connect claude\.exe/)
  })

  it('refuses a Claude .cmd it cannot follow, with what to connect instead', () => {
    const agent = { id: 'claude', kind: 'claude' as const, executablePath: 'C:\\npm\\claude.cmd', args: [] }

    expect(() => terminalLaunchSpec(inputFor('claude', 'win32', 'new', { agent, shimFs: shimFs('@echo hello') }))).toThrow(/Connect claude\.exe/)
  })
})

describe('terminalLaunchSpec: what a Windows .cmd line may carry', () => {
  it.each(KINDS)('never puts the instructions text, the settings or the kickoff on a %s .cmd command line', (kind) => {
    const args = kind === 'custom' ? ['--cwd', '{folder}', '--prompt-file', '{instructions}'] : []
    const agent = { id: kind === 'custom' ? 'cu_01' : kind, kind, executablePath: `C:\\npm\\${kind}.cmd`, args }
    const files = { instructions: WIN.instructions, launcherDir: null, claudeSettings: WIN.settings }
    const spec = terminalLaunchSpec(inputFor(kind, 'win32', 'new', { agent, files, shimFs: shimFs(NATIVE_SHIM) }))
    const line = `${spec.file} ${lineOf(spec)}`

    expect(spec.file === CMD).toBe(kind !== 'claude')
    expect(spec.file.toLowerCase().endsWith('.cmd')).toBe(false)
    if (spec.file === CMD) {
      expect(line).not.toContain(WIN.settings)
      expect(line).not.toContain('## Dark Mechanicus')
      expect(line).not.toContain('Terminal chats')
      expect(line).not.toContain('--append-system-prompt')
      // A custom CLI gets the instructions by file when its stored arguments ask for {instructions}: the path, never the text.
      expect(line.includes(WIN.instructions)).toBe(kind === 'custom')
    }
  })

  it('refuses a .cmd launch cmd.exe cannot carry safely, and a file Windows cannot run', () => {
    const shim = { id: 'codex', kind: 'codex' as const, executablePath: 'C:\\npm\\codex.cmd', args: [] }

    expect(() => terminalLaunchSpec(inputFor('codex', 'win32', 'new', { agent: shim, folder: 'C:\\100% repo', cli: { ...cliFor('win32'), args: ['C:\\cli.js', '--repo', 'C:\\100% repo'] } }))).toThrow(
      /cannot be launched safely/
    )
    expect(() => terminalLaunchSpec(inputFor('codex', 'win32', 'new', { agent: { ...shim, executablePath: 'C:\\Tools\\codex.ps1' } }))).toThrow(/\.exe or \.cmd/)
    expect(() => terminalLaunchSpec(inputFor('custom', 'win32', 'new', { agent: { id: 'cu_01', kind: 'custom', executablePath: 'C:\\Tools\\agent.js', args: [] } }))).toThrow(
      /\.exe or \.cmd/
    )
  })
})

describe('terminalLaunchSpec: values dropped before they reach the command line', () => {
  it.each([['a & b'], ['--dangerously-skip-permissions'], ['x'.repeat(201)], ['default']])('drops the model %s and says so', (model) => {
    for (const kind of ['claude', 'autonomous', 'codex', 'cursor'] as const) {
      const input = inputFor(kind, 'darwin', 'new')
      const spec = terminalLaunchSpec({ ...input, chat: { ...input.chat, model } })

      expect(argsOf(spec)).not.toContain(model)
      expect(argsOf(spec).some((arg) => arg === '--model' || arg === '-m')).toBe(false)
      expect(spec.dropped).toEqual([{ field: 'model', value: model }])
    }
  })

  it('starts a new Claude session, on a fresh id, when the stored one is not a UUID, and says so', () => {
    const input = inputFor('claude', 'darwin', 'resumed')
    const spec = terminalLaunchSpec({ ...input, chat: { ...input.chat, sessionId: 'session; rm -rf ~' } })

    expect(argsOf(spec)).toEqual(['--append-system-prompt-file', MAC.instructions, '--model', 'haiku', '--session-id', NEW_ID])
    expect(spec.sessionId).toBe(NEW_ID)
    expect(spec.dropped).toEqual([{ field: 'sessionId', value: 'session; rm -rf ~' }])
  })

  it('starts a new Codex or Cursor session when the stored id is not a UUID', () => {
    for (const kind of ['codex', 'cursor'] as const) {
      const input = inputFor(kind, 'darwin', 'resumed')
      const spec = terminalLaunchSpec({ ...input, chat: { ...input.chat, sessionId: '--last' } })

      expect(argsOf(spec)).not.toContain('--last')
      expect(spec.sessionId).toBeNull()
      expect(spec.dropped).toEqual([{ field: 'sessionId', value: '--last' }])
      expect(spec.pasteFirst).toBe(instructionsText('darwin'))
    }
  })

  it('passes no model to a custom CLI and reports nothing dropped: the app adds no flags to it', () => {
    const spec = terminalLaunchSpec(inputFor('custom', 'darwin', 'new'))

    expect(argsOf(spec)).not.toContain('haiku')
    expect(spec.dropped).toEqual([])
  })
})
