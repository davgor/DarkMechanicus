import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMORY_WRITE_TOOLS, memoryHookAnswer, memoryHookOutput, pinnedMemoryFolder, type MemoryFolderContext } from './claudeMemoryGuard'

const ASK = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: expect.stringContaining('memory folder')
  }
}

const NOTHING_EXISTS = (path: string): string => {
  throw new Error(`ENOENT: ${path}`)
}

const WIN_FOLDER = 'C:\\work\\repo'
const WIN_TMP = 'C:\\Users\\me\\AppData\\Local\\Temp'
const WIN: MemoryFolderContext = { env: {}, home: 'C:\\Users\\me', tmp: WIN_TMP, platform: 'win32', realpath: NOTHING_EXISTS }
const POSIX: MemoryFolderContext = { env: {}, home: '/home/me', tmp: '/tmp', platform: 'linux', realpath: NOTHING_EXISTS }

/** The JSON a `PreToolUse` hook is given on its standard input, as read. */
const preToolUse = (tool: string, toolInput: unknown, cwd: unknown): Record<string, unknown> => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: toolInput,
  tool_use_id: 'toolu_1',
  session_id: 's',
  transcript_path: 't',
  cwd
})

/** What the hook answers for one call: the CLI's own ruling stands (`{}`), or the person is asked. */
function run(context: MemoryFolderContext, folder: string, input: unknown): unknown {
  return memoryHookAnswer(input, folder, context)
}

const answer = (context: MemoryFolderContext, folder: string, tool: string, toolInput: unknown): unknown => run(context, folder, preToolUse(tool, toolInput, folder))

/** A Write of `file`, from the directory `cwd` (the chat folder unless said). */
const write = (context: MemoryFolderContext, folder: string, file: string, cwd = folder): unknown =>
  run(context, folder, preToolUse('Write', { file_path: file, content: 'x' }, cwd))

describe('memory folder hook: what it registers', () => {
  it('matches the tools that write a file, and only those', () => {
    expect(MEMORY_WRITE_TOOLS).toBe('Write|Edit|MultiEdit|NotebookEdit')
  })
})

describe('memory folder hook: Windows spellings of the memory folder ask', () => {
  const MEMORY = 'C:\\Users\\me\\.claude\\projects\\C--work-repo\\memory'

  it.each([
    ['an absolute path', `${MEMORY}\\MEMORY.md`],
    ['forward slashes', 'C:/Users/me/.claude/projects/C--work-repo/memory/MEMORY.md'],
    ['mixed slashes', 'C:\\Users/me\\.claude/projects\\C--work-repo/memory\\MEMORY.md'],
    ['another case', 'c:\\USERS\\Me\\.CLAUDE\\Projects\\c--work-repo\\MEMORY\\memory.md'],
    ['a ~ path', '~/.claude/projects/C--work-repo/memory/MEMORY.md'],
    ['a ~ path with backslashes', '~\\.claude\\projects\\C--work-repo\\memory\\MEMORY.md'],
    ['a relative path from the chat folder', '..\\..\\Users\\me\\.claude\\projects\\C--work-repo\\memory\\x.md'],
    ['a relative path with forward slashes', '../../Users/me/.claude/projects/p/memory/x.md'],
    ['dot-dot segments in the middle', 'C:\\work\\..\\Users\\me\\.claude\\projects\\p\\sub\\..\\memory\\x.md'],
    ['dot-dot segments after the folder', `${MEMORY}\\old\\..\\x.md`],
    ['a folder below the memory folder', `${MEMORY}\\topics\\deep\\x.md`],
    ['the memory folder itself', MEMORY],
    ['the extended-length prefix', `\\\\?\\${MEMORY}\\x.md`],
    ['the device prefix', `\\\\.\\${MEMORY}\\x.md`],
    ['a trailing dot on the folder name', `${MEMORY}.\\x.md`],
    ['a trailing space on the folder name', `${MEMORY} \\x.md`],
    ['an alternate data stream name', `${MEMORY}::$INDEX_ALLOCATION\\x.md`],
    ['a trailing dot on a parent', 'C:\\Users\\me\\.claude.\\projects\\p\\memory\\x.md']
  ])('asks for %s', (_name, file) => {
    expect(write(WIN, WIN_FOLDER, file)).toEqual(ASK)
  })

  it('resolves a relative path against the directory the CLI is in, not only the chat folder', () => {
    const cwd = 'C:\\Users\\me\\.claude\\projects\\p'

    expect(write(WIN, WIN_FOLDER, 'memory\\x.md', cwd)).toEqual(ASK)
    expect(write(WIN, WIN_FOLDER, 'memory\\x.md', WIN_FOLDER)).toEqual({})
  })

  it('resolves a relative path against the chat folder when the CLI says it is somewhere else', () => {
    const folder = 'C:\\Users\\me\\.claude\\projects\\p'

    expect(write(WIN, folder, 'memory\\x.md', 'C:\\elsewhere')).toEqual(ASK)
  })

  it('asks for the folder of any project, and of any tool that writes a file', () => {
    const folder = 'C:\\Users\\me\\.claude\\projects\\other-project\\memory\\a.md'

    expect(answer(WIN, WIN_FOLDER, 'Edit', { file_path: folder, old_string: 'a', new_string: 'b' })).toEqual(ASK)
    expect(answer(WIN, WIN_FOLDER, 'MultiEdit', { file_path: folder, edits: [] })).toEqual(ASK)
    expect(answer(WIN, WIN_FOLDER, 'NotebookEdit', { notebook_path: folder.replace('.md', '.ipynb'), new_source: '' })).toEqual(ASK)
  })
})

describe('memory folder hook: what is not the memory folder', () => {
  it.each([
    ['an ordinary file in the chat folder', 'C:\\work\\repo\\src\\a.ts'],
    ['an ordinary relative path', 'src\\a.ts'],
    ['a folder named memory in the chat folder', 'C:\\work\\repo\\memory\\a.md'],
    ['a project folder outside memory', 'C:\\Users\\me\\.claude\\projects\\p\\notes.md'],
    ['a file called memory directly under projects', 'C:\\Users\\me\\.claude\\projects\\memory\\a.md'],
    ['a sibling that shares the name prefix', 'C:\\Users\\me\\.claude\\projects\\p\\memory-old\\a.md'],
    ['a projects folder with another name', 'C:\\Users\\me\\.claude\\projectsX\\p\\memory\\a.md'],
    ['the settings file', 'C:\\Users\\me\\.claude\\settings.json'],
    ['a name made only of dots', 'C:\\work\\repo\\...\\a.md'],
    ['a memory folder below another folder', 'C:\\Users\\me\\.claude\\other\\projects\\p\\memory\\a.md'],
    ['another user\'s memory folder', 'C:\\Users\\you\\.claude\\projects\\p\\memory\\a.md'],
    ['a dot-dot that leaves the memory folder', 'C:\\Users\\me\\.claude\\projects\\p\\memory\\..\\notes.md'],
    ['a stream name that is not the folder', 'C:\\Users\\me\\.claude\\projects\\p\\memory-x::$DATA\\a.md']
  ])('leaves %s to the CLI', (_name, file) => {
    expect(write(WIN, WIN_FOLDER, file)).toEqual({})
  })

  it('leaves tools that do not write, and other events, alone', () => {
    const file = 'C:\\Users\\me\\.claude\\projects\\p\\memory\\a.md'

    expect(answer(WIN, WIN_FOLDER, 'Read', { file_path: file })).toEqual({})
    expect(answer(WIN, WIN_FOLDER, 'Bash', { command: `echo hi >> ${file}` })).toEqual({})
    expect(run(WIN, WIN_FOLDER, { hook_event_name: 'Notification' })).toEqual({})
  })
})

describe('memory folder hook: the folder of the CLI and of the platform', () => {
  it('follows CLAUDE_CONFIG_DIR, and still covers the default folder', () => {
    const moved = { ...WIN, env: { CLAUDE_CONFIG_DIR: 'D:\\cfg' } }

    expect(write(moved, WIN_FOLDER, 'D:\\cfg\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(moved, WIN_FOLDER, 'd:/CFG/projects/p/memory/a.md')).toEqual(ASK)
    expect(write(moved, WIN_FOLDER, 'C:\\Users\\me\\.claude\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(moved, WIN_FOLDER, 'D:\\cfg\\projects\\p\\notes.md')).toEqual({})
  })

  it('reads a CLAUDE_CONFIG_DIR with a ~ or a relative path', () => {
    const home = { ...WIN, env: { CLAUDE_CONFIG_DIR: '~/alt' } }
    const relative = { ...WIN, env: { CLAUDE_CONFIG_DIR: 'cfg' } }
    const bare = { ...WIN, env: { CLAUDE_CONFIG_DIR: '~' } }

    expect(write(bare, WIN_FOLDER, 'C:\\Users\\me\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(home, WIN_FOLDER, 'C:\\Users\\me\\alt\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(relative, WIN_FOLDER, 'C:\\work\\repo\\cfg\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(home, WIN_FOLDER, 'C:\\Users\\me\\other\\projects\\p\\memory\\a.md')).toEqual({})
  })

  it('ignores a CLAUDE_CONFIG_DIR that is empty', () => {
    const blank = { ...WIN, env: { CLAUDE_CONFIG_DIR: '  ' } }

    expect(write(blank, WIN_FOLDER, 'C:\\Users\\me\\.claude\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(blank, WIN_FOLDER, 'C:\\work\\repo\\a.md')).toEqual({})
  })

  it('reads paths the POSIX way on other platforms, and leaves a backslash as part of a name', () => {
    const folder = '/work/repo'

    expect(write(POSIX, folder, '/home/me/.claude/projects/p/memory/a.md')).toEqual(ASK)
    expect(write(POSIX, folder, '~/.claude/projects/p/memory/a.md')).toEqual(ASK)
    expect(write(POSIX, folder, '../../home/me/.claude/projects/p/memory/a.md')).toEqual(ASK)
    expect(write(POSIX, folder, '/home/me/.Claude/Projects/p/MEMORY/a.md')).toEqual(ASK)
    expect(write(POSIX, folder, '~\\.claude\\projects\\p\\memory\\a.md')).toEqual({})
    expect(write(POSIX, folder, '/work/repo/src/a.ts')).toEqual({})
    expect(write(POSIX, folder, '/home/me/.claude/projects/p/memory.old/a.md')).toEqual({})
    expect(write({ ...POSIX, env: { CLAUDE_CONFIG_DIR: '/etc/cfg' } }, folder, '/etc/cfg/projects/p/memory/a.md')).toEqual(ASK)
  })

  it('treats names that differ only in Unicode form as the same name', () => {
    const home = { ...POSIX, home: '/home/jose\u0301' }

    expect(write(home, '/work/repo', '/home/jos\u00e9/.claude/projects/p/memory/a.md')).toEqual(ASK)
  })
})

describe('memory folder hook: the folder the CLI is told to keep its memory in', () => {
  const PINNED = `${WIN_TMP}\\dark-mechanicus-unused-memory`

  it('is a folder of the app in the temp folder, spelled for the platform', () => {
    expect(pinnedMemoryFolder(WIN)).toBe(PINNED)
    expect(pinnedMemoryFolder(POSIX)).toBe('/tmp/dark-mechanicus-unused-memory')
  })

  it('asks for a write into it, however it is spelled, and for nothing beside it', () => {
    expect(write(WIN, WIN_FOLDER, `${PINNED}\\MEMORY.md`)).toEqual(ASK)
    expect(write(WIN, WIN_FOLDER, `${PINNED}\\deep\\er\\a.md`)).toEqual(ASK)
    expect(write(WIN, WIN_FOLDER, 'c:/users/ME/appdata/local/TEMP/Dark-Mechanicus-Unused-Memory/a.md')).toEqual(ASK)
    expect(write(WIN, WIN_FOLDER, `${WIN_TMP}\\other.md`)).toEqual({})
    expect(write(WIN, WIN_FOLDER, `${PINNED}-x\\a.md`)).toEqual({})
    expect(write(POSIX, '/work/repo', '/tmp/dark-mechanicus-unused-memory/a.md')).toEqual(ASK)
  })
})

describe('memory folder hook: links and folders that exist', () => {
  it('follows a link to the memory folder, even for a file that does not exist yet', () => {
    const links: Record<string, string> = { 'C:\\work\\repo\\notes': 'C:\\Users\\me\\.claude\\projects\\p\\memory' }
    const context = { ...WIN, realpath: (path: string) => links[path] ?? NOTHING_EXISTS(path) }

    expect(write(context, WIN_FOLDER, 'C:\\work\\repo\\notes\\new\\a.md')).toEqual(ASK)
    expect(write(context, WIN_FOLDER, 'notes\\a.md')).toEqual(ASK)
    expect(write(context, WIN_FOLDER, 'C:\\work\\repo\\other\\a.md')).toEqual({})
  })

  it('compares with the real path of the configuration folder when that folder is itself a link', () => {
    const links: Record<string, string> = { 'C:\\Users\\me\\.claude': 'D:\\store\\claude' }
    const context = { ...WIN, realpath: (path: string) => links[path] ?? NOTHING_EXISTS(path) }

    expect(write(context, WIN_FOLDER, 'D:\\store\\claude\\projects\\p\\memory\\a.md')).toEqual(ASK)
    expect(write(context, WIN_FOLDER, 'D:\\store\\claude\\projects\\p\\notes.md')).toEqual({})
  })

  it('goes on with the path as written when nothing on it exists, not even the drive', () => {
    expect(write(WIN, WIN_FOLDER, 'Z:\\nowhere\\a.md')).toEqual({})
  })
})

describe('memory folder hook: a request it cannot read asks', () => {
  it('asks when the call names no file, or names it in a form it does not know', () => {
    expect(answer(WIN, WIN_FOLDER, 'Write', {})).toEqual(ASK)
    expect(answer(WIN, WIN_FOLDER, 'Write', { file_path: '' })).toEqual(ASK)
    expect(answer(WIN, WIN_FOLDER, 'Write', { file_path: 42, filePath: 'a.md' })).toEqual(ASK)
    expect(answer(WIN, WIN_FOLDER, 'Write', 'a.md')).toEqual(ASK)
    expect(answer(WIN, WIN_FOLDER, 'Write', null)).toEqual(ASK)
  })

  it('asks when the call cannot be examined at all', () => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Write', get tool_input(): never { throw new Error('boom') } }

    expect(run(WIN, WIN_FOLDER, input)).toEqual(ASK)
  })

  it('does not look at the directory the CLI reports when it is not text', () => {
    const input = preToolUse('Write', { file_path: 'C:\\Users\\me\\.claude\\projects\\p\\memory\\a.md' }, 7)

    expect(run(WIN, WIN_FOLDER, input)).toEqual(ASK)
  })

  it('asks when what the CLI sent is not an object', () => {
    expect(run(WIN, WIN_FOLDER, null)).toEqual(ASK)
    expect(run(WIN, WIN_FOLDER, 'Write')).toEqual(ASK)
    expect(run(WIN, WIN_FOLDER, 7)).toEqual(ASK)
  })
})

describe('memory folder hook: what the hook script prints', () => {
  const ARGS = ['/work/repo', '/home/me', '/tmp']
  const stdin = (tool: string, file: string, cwd = '/work/repo'): string => JSON.stringify(preToolUse(tool, { file_path: file, content: 'x' }, cwd))
  const printed = (text: string): unknown => JSON.parse(text)

  it('prints the ask answer for a write into a memory folder, and nothing for anything else', () => {
    expect(printed(memoryHookOutput(ARGS, stdin('Write', '/home/me/.claude/projects/p/memory/a.md'), {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput(ARGS, stdin('Edit', '~/.claude/projects/p/memory/a.md'), {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput(ARGS, stdin('Write', '/tmp/dark-mechanicus-unused-memory/a.md'), {}, 'darwin'))).toEqual(ASK)
    expect(memoryHookOutput(ARGS, stdin('Write', '/work/repo/src/a.ts'), {}, 'darwin')).toBe('')
    expect(memoryHookOutput(ARGS, stdin('Read', '/home/me/.claude/projects/p/memory/a.md'), {}, 'darwin')).toBe('')
  })

  it('reads the chat folder, the home folder and the temp folder from its arguments, and CLAUDE_CONFIG_DIR from its environment', () => {
    expect(printed(memoryHookOutput(ARGS, stdin('Write', 'memory/a.md', '/home/me/.claude/projects/p'), {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput(['/w', '/Users/you', '/var/t'], stdin('Write', '/var/t/dark-mechanicus-unused-memory/a.md', '/w'), {}, 'darwin'))).toEqual(ASK)
    expect(memoryHookOutput(['/w', '/Users/you', '/var/t'], stdin('Write', '/tmp/dark-mechanicus-unused-memory/a.md', '/w'), {}, 'darwin')).toBe('')
    expect(printed(memoryHookOutput(ARGS, stdin('Write', '/etc/cfg/projects/p/memory/a.md'), { CLAUDE_CONFIG_DIR: '/etc/cfg' }, 'darwin'))).toEqual(ASK)
    expect(memoryHookOutput(ARGS, stdin('Write', '/etc/cfg/projects/p/memory/a.md'), {}, 'darwin')).toBe('')
  })

  it('asks when its input is not JSON, or its arguments are not the three folders', () => {
    const ordinaryWrite = stdin('Write', '/work/repo/src/a.ts')

    expect(printed(memoryHookOutput(ARGS, '{"hook_event_name":', {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput(ARGS, '', {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput(ARGS.slice(0, 2), ordinaryWrite, {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput([...ARGS, '/extra'], ordinaryWrite, {}, 'darwin'))).toEqual(ASK)
    expect(printed(memoryHookOutput(['/work/repo', '', '/tmp'], ordinaryWrite, {}, 'darwin'))).toEqual(ASK)
  })
})

describe('memory folder hook: real folders and links', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const scratch = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dm213-')))
    made.push(dir)
    return dir
  }

  it('finds the memory folder through a real link in the chat folder', () => {
    const root = scratch()
    const memory = join(root, 'home', '.claude', 'projects', 'p', 'memory')
    const folder = join(root, 'repo')
    mkdirSync(memory, { recursive: true })
    mkdirSync(folder)
    symlinkSync(memory, join(folder, 'notes'), process.platform === 'win32' ? 'junction' : 'dir')
    const context: MemoryFolderContext = { env: {}, home: join(root, 'home'), tmp: join(root, 'tmp'), platform: process.platform }

    expect(write(context, folder, join(folder, 'notes', 'a.md'))).toEqual(ASK)
    expect(write(context, folder, join('notes', 'a.md'))).toEqual(ASK)
    expect(write(context, folder, join(folder, 'src', 'a.md'))).toEqual({})
  })

  it('asks for a file that already exists in the memory folder', () => {
    const root = scratch()
    const memory = join(root, 'home', '.claude', 'projects', 'p', 'memory')
    mkdirSync(memory, { recursive: true })
    writeFileSync(join(memory, 'existing.md'), 'seed')
    const context: MemoryFolderContext = { env: {}, home: join(root, 'home'), tmp: join(root, 'tmp'), platform: process.platform }

    expect(answer(context, root, 'Edit', { file_path: join(memory, 'existing.md'), old_string: 'seed', new_string: 'x' })).toEqual(ASK)
    expect(write(context, root, join(root, 'home', '.claude', 'projects', 'p', 'notes.md'))).toEqual({})
  })
})
