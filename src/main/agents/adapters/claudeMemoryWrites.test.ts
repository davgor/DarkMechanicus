import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { ClaudeAdapterDeps } from './claude'
import { init, pendingApproval, preToolUse, replay, startRig, success, type Rig } from './__mocks__/fakeClaudeSdk'

/** A chat on Windows, where the memory folder is `C:\Users\me\.claude\projects\<project>\memory\`. */
const FOLDER = 'C:\\work\\repo'
const MEMORY = 'C:\\Users\\me\\.claude\\projects\\C--work-repo\\memory'
const ASK = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason: expect.stringContaining('memory folder')
  }
}

const TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp'
const PINNED = `${TEMP}\\dark-mechanicus-unused-memory`

const windows = (env: NodeJS.ProcessEnv = {}): Partial<ClaudeAdapterDeps> => ({
  platform: 'win32',
  homeDir: () => 'C:\\Users\\me',
  tempDir: () => TEMP,
  env: () => env
})

async function chat(deps: Partial<ClaudeAdapterDeps> = windows(), folder = FOLDER): Promise<{ rig: Rig; options: Options }> {
  const rig = await startRig({ plans: [replay(init(), success('ok'))], start: { folder }, deps })
  await rig.adapter.send('hi')
  return { rig, options: rig.sdk.launches[0]?.options as Options }
}

describe('Claude adapter: writes into its own memory folder (hook, 1)', () => {
  it('registers one PreToolUse hook for the tools that write a file, next to canUseTool and the memory switch', async () => {
    const { options } = await chat()

    expect(Object.keys(options.hooks ?? {})).toEqual(['PreToolUse'])
    expect(options.hooks?.PreToolUse).toHaveLength(1)
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit')
    expect(options.canUseTool).toBeTypeOf('function')
    expect(options.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })
  })

  it("moves the CLI's own memory folder to one that nothing reads, through an inline setting and no settings file", async () => {
    const { options } = await chat()

    expect(options.settings).toEqual({ autoMemoryDirectory: PINNED })
    expect(options).toMatchObject({ settingSources: ['user', 'project', 'local'], permissionMode: 'default' })
  })

  it('puts it in the temp folder of a POSIX platform, too', async () => {
    const { options } = await chat({ platform: 'linux', homeDir: () => '/home/me', tempDir: () => '/tmp', env: () => ({}) }, '/work/repo')

    expect(options.settings).toEqual({ autoMemoryDirectory: '/tmp/dark-mechanicus-unused-memory' })
  })
})

describe('Claude adapter: writes into its own memory folder (hook, 2)', () => {
  it('registers it again on every process the chat starts', async () => {
    const rig = await startRig({ plans: [{ dieEarly: 'end' }, replay(init(), success('ok'))], start: { folder: FOLDER, sessionId: null }, deps: windows() })
    await rig.adapter.send('one').catch(() => undefined)
    await rig.adapter.send('two').catch(() => undefined)

    for (const launch of rig.sdk.launches) {
      expect(launch.options.hooks?.PreToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit|NotebookEdit')
    }
  })

  it.each([
    ['an absolute path', `${MEMORY}\\MEMORY.md`],
    ['an absolute path with forward slashes', 'C:/Users/me/.claude/projects/C--work-repo/memory/MEMORY.md'],
    ['an absolute path in other letter case', 'c:\\users\\ME\\.CLAUDE\\PROJECTS\\c--work-repo\\Memory\\memory.md'],
    ['a ~ path', '~/.claude/projects/C--work-repo/memory/MEMORY.md'],
    ['a ~ path with backslashes', '~\\.claude\\projects\\C--work-repo\\memory\\MEMORY.md'],
    ['a path relative to the chat folder', '..\\..\\Users\\me\\.claude\\projects\\C--work-repo\\memory\\MEMORY.md'],
    ['a relative path with forward slashes', '../../Users/me/.claude/projects/C--work-repo/memory/MEMORY.md'],
    ['a path with dot-dot segments', 'C:\\work\\repo\\..\\..\\Users\\me\\.claude\\projects\\x\\..\\C--work-repo\\memory\\MEMORY.md'],
    ['a file that exists already', `${MEMORY}\\existing.md`]
  ])('asks before a Write into the memory folder by %s', async (_name, file) => {
    const { options } = await chat()

    expect(await preToolUse(options, 'Write', { file_path: file, content: 'hi' }, FOLDER)).toEqual(ASK)
  })

})

describe('Claude adapter: writes into its own memory folder (hook, 3)', () => {
  it('asks before an Edit, a MultiEdit and a NotebookEdit there, too', async () => {
    const { options } = await chat()

    expect(await preToolUse(options, 'Edit', { file_path: `${MEMORY}\\a.md`, old_string: 'a', new_string: 'b' }, FOLDER)).toEqual(ASK)
    expect(await preToolUse(options, 'MultiEdit', { file_path: `${MEMORY}\\a.md`, edits: [] }, FOLDER)).toEqual(ASK)
    expect(await preToolUse(options, 'NotebookEdit', { notebook_path: `${MEMORY}\\a.ipynb`, new_source: 'x' }, FOLDER)).toEqual(ASK)
  })

  it('leaves an ordinary edit inside the chat folder to the CLI, whichever way the path is written', async () => {
    const { options } = await chat()

    expect(await preToolUse(options, 'Write', { file_path: 'C:\\work\\repo\\src\\a.ts', content: 'x' }, FOLDER)).toEqual({})
    expect(await preToolUse(options, 'Write', { file_path: 'C:/work/repo/src/a.ts', content: 'x' }, FOLDER)).toEqual({})
    expect(await preToolUse(options, 'Edit', { file_path: 'src\\a.ts', old_string: 'a', new_string: 'b' }, FOLDER)).toEqual({})
    expect(await preToolUse(options, 'MultiEdit', { file_path: 'src/a.ts', edits: [] }, FOLDER)).toEqual({})
    expect(await preToolUse(options, 'NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' }, FOLDER)).toEqual({})
    expect(await preToolUse(options, 'Write', { file_path: 'C:\\work\\repo\\memory\\a.md', content: 'x' }, FOLDER)).toEqual({})
    expect(await preToolUse(options, 'Bash', { command: 'ls' }, FOLDER)).toEqual({})
  })

})

describe('Claude adapter: writes into its own memory folder (hook, 4)', () => {
  it('follows the CLAUDE_CONFIG_DIR it hands the CLI, and the home folder of the person', async () => {
    const { options } = await chat(windows({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }))

    expect(await preToolUse(options, 'Write', { file_path: 'D:\\cfg\\projects\\p\\memory\\a.md', content: 'x' }, FOLDER)).toEqual(ASK)
    expect(await preToolUse(options, 'Write', { file_path: `${MEMORY}\\a.md`, content: 'x' }, FOLDER)).toEqual(ASK)
    expect(await preToolUse(options, 'Write', { file_path: 'D:\\cfg\\projects\\p\\notes.md', content: 'x' }, FOLDER)).toEqual({})
  })

  it('asks before a write into the folder it moved the memory to, too', async () => {
    const { options } = await chat()

    expect(await preToolUse(options, 'Write', { file_path: `${PINNED}\\MEMORY.md`, content: 'x' }, FOLDER)).toEqual(ASK)
  })

  it('judges a relative path from where the CLI says it is as well as from the chat folder', async () => {
    const { options } = await chat()

    expect(await preToolUse(options, 'Write', { file_path: 'memory\\a.md', content: 'x' }, 'C:\\Users\\me\\.claude\\projects\\C--work-repo')).toEqual(ASK)
    expect(await preToolUse(options, 'Write', { file_path: 'memory\\a.md', content: 'x' }, FOLDER)).toEqual({})
  })

  it('reads the folder the POSIX way when the platform is not Windows', async () => {
    const { options } = await chat({ platform: 'linux', homeDir: () => '/home/me', env: () => ({}) }, '/work/repo')

    expect(await preToolUse(options, 'Write', { file_path: '/home/me/.claude/projects/p/memory/a.md', content: 'x' }, '/work/repo')).toEqual(ASK)
    expect(await preToolUse(options, 'Write', { file_path: '~/.claude/projects/p/memory/a.md', content: 'x' }, '/work/repo')).toEqual(ASK)
    expect(await preToolUse(options, 'Write', { file_path: '/work/repo/src/a.ts', content: 'x' }, '/work/repo')).toEqual({})
  })
})

describe('Claude adapter: writes into its own memory folder (approval)', () => {
  const memoryWrite = { file_path: `${MEMORY}\\MEMORY.md`, content: 'hi' }

  async function runWrite(answer: 'allow_once' | 'allow_chat' | 'deny'): Promise<{ outcome: PermissionResult[]; rig: Rig }> {
    const outcome: PermissionResult[] = []
    const rig = await startRig({
      plans: [
        {
          script: async ({ emit, ask, options }) => {
            emit(init())
            // The CLI asks the hook first, then (because it answered "ask") the host.
            expect(await preToolUse(options, 'Write', memoryWrite, FOLDER)).toEqual(ASK)
            outcome.push(await ask('Write', memoryWrite, 'toolu_mem'))
            emit(success('done'))
          }
        }
      ],
      start: { folder: FOLDER },
      deps: windows()
    })
    const turn = rig.adapter.send('write it')
    ;(await pendingApproval(rig)).respond(answer)
    await turn
    return { outcome, rig }
  }

  it('raises an approval request like any file edit, and writes nothing before the person answers', async () => {
    const { rig, outcome } = await runWrite('allow_once')

    expect(rig.approvals[0]?.request).toMatchObject({
      requestId: 'toolu_mem',
      category: 'file_edit',
      tool: 'Write',
      summary: `Write ${MEMORY}\\MEMORY.md`,
      input: memoryWrite
    })
    expect(outcome).toEqual([{ behavior: 'allow', updatedInput: memoryWrite, toolUseID: 'toolu_mem' }])
  })

  it('refuses the write when the person says Deny', async () => {
    const { outcome } = await runWrite('deny')

    expect(outcome).toEqual([{ behavior: 'deny', message: expect.stringContaining('declined'), toolUseID: 'toolu_mem' }])
  })

  it('allows it on Allow for this chat, as it does for any edit', async () => {
    const { outcome } = await runWrite('allow_chat')

    expect(outcome[0]).toMatchObject({ behavior: 'allow' })
  })
})
