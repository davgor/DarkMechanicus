import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { createIdGenerator } from '../../core/ids'
import type { ChatItem } from '../../shared/agents/chat'
import { createFolderRegistry, type RegistryFs } from '../desktop/folderRegistry'
import { CLAIM_TOKEN_MASK } from './claimTokenMask'
import { createChatStore, type ChatStore, type ChatStoreFs, type NewChat } from './chatStore'

interface MemoryFs extends ChatStoreFs {
  files: Map<string, string>
  /** Existing folders, as canonical paths. */
  dirs: Set<string>
  /** Spelling -> canonical target, like a symlink. */
  links: Map<string, string>
}

function createMemoryFs(): MemoryFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const links = new Map<string, string>()
  return {
    files,
    dirs,
    links,
    removeFile(path) {
      files.delete(path)
    },
    replaceFile(path, data) {
      files.set(path, data)
    },
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data)
    },
    mkdirp() {},
    realpath(path) {
      const resolved = resolve(path)
      const target = links.get(resolved) ?? resolved
      if (!dirs.has(target)) {
        throw new Error(`ENOENT: ${path}`)
      }
      return target
    }
  }
}

const ROOT = resolve('/state/agents/chats')
const REPO = resolve('/work/repo')
const OTHER = resolve('/work/other')

function memoryFs(): MemoryFs {
  const fs = createMemoryFs()
  fs.dirs.add(REPO).add(OTHER)
  return fs
}

/** Deterministic, lexically ordered timestamps: one second apart. */
function counterNow(): () => string {
  let tick = 0
  return () => {
    tick += 1
    const minutes = String(Math.floor(tick / 60)).padStart(2, '0')
    const seconds = String(tick % 60).padStart(2, '0')
    return `2026-01-01T00:${minutes}:${seconds}.000Z`
  }
}

/** One counter for every store in a test, so a reopened store never reuses an id. */
let chatCount = 0
function nextChatId(): string {
  chatCount += 1
  return `chat_${chatCount}`
}

function openStore(fs: ChatStoreFs): ChatStore {
  return createChatStore({ root: ROOT, fs, now: counterNow(), newId: nextChatId })
}

const NEW_CHAT: NewChat = { folder: REPO, agent: 'claude', model: 'opus', role: 'orchestrator', allowSave: true }
const AT = '2026-02-01T00:00:00.000Z'

let itemCount = 0
function userMessage(text: string): ChatItem {
  itemCount += 1
  return { id: `it_${itemCount}`, at: AT, kind: 'user_message', text }
}

function transcriptTexts(store: ChatStore, folder: string, id: string): string[] {
  const transcript = store.readTranscript({ folder, id })
  return (transcript?.items ?? []).map((item) => (item.kind === 'user_message' ? item.text : item.kind))
}

function chatIds(store: ChatStore, folder: string): string[] {
  return store.listChats(folder).map((chat) => chat.id)
}

function transcriptPath(fs: MemoryFs, id: string): string {
  const path = [...fs.files.keys()].find((key) => key.endsWith(`${id}.jsonl`))
  if (path === undefined) {
    throw new Error(`no transcript file for ${id}`)
  }
  return path
}

function indexPath(fs: MemoryFs): string {
  return [...fs.files.keys()].find((key) => key.endsWith('index.jsonl')) ?? ''
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
  return 'no error'
}

describe('chat store round trip', () => {
  it('creates a chat and lists it', () => {
    const store = openStore(memoryFs())
    const chat = store.createChat({ ...NEW_CHAT, title: 'Run the epic' })
    expect(chat).toEqual({
      id: expect.stringMatching(/^chat_\d+$/) as string,
      folder: REPO,
      agent: 'claude',
      model: 'opus',
      role: 'orchestrator',
      allowSave: true,
      title: 'Run the epic',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      sessionId: null
    })
    expect(store.listChats(REPO)).toEqual([chat])
    expect(store.getChat(chat)).toEqual(chat)
  })

  it('appends items and reopens them, in order, from a fresh store over the same files', () => {
    const fs = memoryFs()
    const chat = openStore(fs).createChat(NEW_CHAT)
    const writer = openStore(fs)
    writer.appendItem(chat, userMessage('one'))
    writer.appendItem(chat, userMessage('two'))
    writer.appendItem(chat, { id: 'a', at: AT, kind: 'assistant_text', text: 'three' })

    const reopened = openStore(fs)
    expect(chatIds(reopened, REPO)).toEqual([chat.id])
    const transcript = reopened.readTranscript(chat)
    expect(transcript?.chat.id).toBe(chat.id)
    expect(transcript?.skipped).toBe(0)
    expect(transcriptTexts(reopened, REPO, chat.id)).toEqual(['one', 'two', 'assistant_text'])
  })

  it('returns the item it stored, and never rewrites what is already on disk', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    const stored = store.appendItem(chat, userMessage('one'))
    expect(stored).toMatchObject({ kind: 'user_message', text: 'one' })
    const before = fs.files.get(transcriptPath(fs, chat.id)) ?? ''
    store.appendItem(chat, userMessage('two'))
    const after = fs.files.get(transcriptPath(fs, chat.id)) ?? ''
    expect(after.startsWith(before)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
  })
})

describe('chat store run link', () => {
  it('keeps the run a chat orchestrates, and a chat without one has no run id', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const orchestrator = store.createChat({ ...NEW_CHAT, runId: 'rn_1' })
    const plain = store.createChat(NEW_CHAT)
    expect(orchestrator.runId).toBe('rn_1')
    expect(plain).not.toHaveProperty('runId')
    store.updateChat(orchestrator, { title: 'Renamed' })

    const reopened = openStore(fs)
    expect(reopened.getChat(orchestrator)).toMatchObject({ title: 'Renamed', runId: 'rn_1' })
    expect(reopened.getChat(plain)).not.toHaveProperty('runId')
  })
})

describe('chat store item replacement', () => {
  it('lets a later line with the same id replace the earlier one in place', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    const call = { id: 'call_1', at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'ls' } } as const
    store.appendItem(chat, { ...call, status: 'running', resultSummary: null })
    store.appendItem(chat, userMessage('between'))
    store.appendItem(chat, { ...call, status: 'completed', resultSummary: '2 files' })
    const items = openStore(fs).readTranscript(chat)?.items ?? []
    expect(items.map((item) => item.kind)).toEqual(['tool_call', 'user_message'])
    expect(items[0]).toMatchObject({ status: 'completed', resultSummary: '2 files' })
  })
})

describe('chat store updates and errors', () => {
  it('updates the title, model and vendor session id, and keeps them across a reopen', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    const updated = store.updateChat(chat, { title: 'Renamed', model: 'sonnet', sessionId: 'vendor-1' })
    expect(updated).toMatchObject({ title: 'Renamed', model: 'sonnet', sessionId: 'vendor-1' })
    expect(updated.updatedAt > chat.updatedAt).toBe(true)
    expect(openStore(fs).getChat(chat)).toEqual(updated)
  })

  it('lists the most recently updated chat first', () => {
    const store = openStore(memoryFs())
    const first = store.createChat(NEW_CHAT)
    const second = store.createChat(NEW_CHAT)
    expect(chatIds(store, REPO)).toEqual([second.id, first.id])
    store.appendItem(first, userMessage('bumps it'))
    expect(chatIds(store, REPO)).toEqual([first.id, second.id])
  })

  it('refuses to append to or update a chat it does not know', () => {
    const store = openStore(memoryFs())
    const ghost = { folder: REPO, id: 'chat_ghost' }
    expect(errorCode(() => store.appendItem(ghost, userMessage('x')))).toBe('not_found')
    expect(errorCode(() => store.updateChat(ghost, { title: 'x' }))).toBe('not_found')
    expect(store.getChat(ghost)).toBeNull()
    expect(store.readTranscript(ghost)).toBeNull()
  })

  it('rejects an invalid item without writing anything', () => {
    const store = openStore(memoryFs())
    const chat = store.createChat(NEW_CHAT)
    const bad = { id: 'x', at: 'now', kind: 'hologram' } as unknown as ChatItem
    expect(errorCode(() => store.appendItem(chat, bad))).toBe('invalid_input')
    expect(transcriptTexts(store, REPO, chat.id)).toEqual([])
  })

  it('rejects a relative folder', () => {
    expect(errorCode(() => openStore(memoryFs()).createChat({ ...NEW_CHAT, folder: 'repo' }))).toBe('invalid_input')
  })
})

describe('chat store reads', () => {
  function seeded(): { fs: MemoryFs; chat: { folder: string; id: string }; path: string } {
    const fs = memoryFs()
    const chat = openStore(fs).createChat(NEW_CHAT)
    const store = openStore(fs)
    store.appendItem(chat, userMessage('one'))
    store.appendItem(chat, userMessage('two'))
    return { fs, chat, path: transcriptPath(fs, chat.id) }
  }

  it('skips a truncated final line', () => {
    const { fs, chat, path } = seeded()
    fs.files.set(path, `${fs.files.get(path) ?? ''}{"id":"it_9","at":"2026-02-01T00:00:00.000Z","kind":"user_mess`)
    const transcript = openStore(fs).readTranscript(chat)
    expect(transcript?.items).toHaveLength(2)
    expect(transcript?.skipped).toBe(1)
  })

  it('keeps appending cleanly after a truncated final line', () => {
    const { fs, chat, path } = seeded()
    fs.files.set(path, `${fs.files.get(path) ?? ''}{"id":"it_9","kind":"user_mess`)
    openStore(fs).appendItem(chat, userMessage('three'))
    expect(transcriptTexts(openStore(fs), REPO, chat.id)).toEqual(['one', 'two', 'three'])
  })

  it('skips an item of unknown kind and keeps the rest of the chat', () => {
    const { fs, chat, path } = seeded()
    const future = JSON.stringify({ id: 'f1', at: AT, kind: 'subagent_spawn', threadId: 't1' })
    fs.files.set(path, `${fs.files.get(path) ?? ''}${future}\n`)
    openStore(fs).appendItem(chat, userMessage('after'))
    const reopened = openStore(fs)
    expect(transcriptTexts(reopened, REPO, chat.id)).toEqual(['one', 'two', 'after'])
    expect(reopened.readTranscript(chat)?.skipped).toBe(1)
  })

  it('skips garbage lines and blank lines', () => {
    const { fs, chat, path } = seeded()
    fs.files.set(path, `not json\n\n${fs.files.get(path) ?? ''}[1,2]\n`)
    const transcript = openStore(fs).readTranscript(chat)
    expect(transcript?.items).toHaveLength(2)
    expect(transcript?.skipped).toBe(2)
  })

  it('tolerates a truncated last line in the folder index', () => {
    const { fs, chat } = seeded()
    const second = openStore(fs).createChat(NEW_CHAT)
    fs.files.set(indexPath(fs), `${fs.files.get(indexPath(fs)) ?? ''}{"id":"chat_77","folder":"/x","ag`)
    expect(chatIds(openStore(fs), REPO).sort()).toEqual([chat.id, second.id].sort())
  })
})

function registryFsOver(fs: MemoryFs): RegistryFs {
  return {
    readFile: (path) => fs.readFile(path),
    writeFile: (path, data) => {
      fs.files.set(path, data)
    },
    rename: (from, to) => {
      fs.files.set(to, fs.files.get(from) ?? '')
      fs.files.delete(from)
    },
    mkdirp() {},
    realpath: (path) => fs.realpath(path),
    exists: (path) => fs.files.has(path),
    isDirectory: (path) => fs.dirs.has(path)
  }
}

describe('chats are keyed by the canonical folder path', () => {
  it('finds the same chats through different spellings of one folder', () => {
    const fs = memoryFs()
    fs.links.set(resolve('/work/link'), REPO)
    const store = openStore(fs)
    const chat = store.createChat({ ...NEW_CHAT, folder: resolve('/work/link') })
    expect(chat.folder).toBe(REPO)
    expect(chatIds(store, `${REPO}${sep}`)).toEqual([chat.id])
    expect(chatIds(store, join(REPO, '..', 'repo'))).toEqual([chat.id])
    expect(chatIds(store, resolve('/work/link'))).toEqual([chat.id])
    store.appendItem({ folder: resolve('/work/link'), id: chat.id }, userMessage('via the link'))
    expect(transcriptTexts(store, REPO, chat.id)).toEqual(['via the link'])
  })

  it('keeps folders apart', () => {
    const store = openStore(memoryFs())
    const mine = store.createChat(NEW_CHAT)
    const theirs = store.createChat({ ...NEW_CHAT, folder: OTHER })
    expect(chatIds(store, REPO)).toEqual([mine.id])
    expect(chatIds(store, OTHER)).toEqual([theirs.id])
    expect(store.getChat({ folder: OTHER, id: mine.id })).toBeNull()
  })

  it('writes under a filesystem-safe folder key, with an index and one file per chat', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    store.appendItem(chat, userMessage('x'))
    const paths = [...fs.files.keys()].map((path) => path.slice(ROOT.length + 1).split(sep))
    expect(paths).toHaveLength(2)
    const index = paths.find((parts) => parts[1] === 'index.jsonl')
    const transcript = paths.find((parts) => parts[1] === `${chat.id}.jsonl`)
    expect(index?.[0]).toMatch(/^[0-9a-f]{24}$/)
    expect(transcript?.[0]).toBe(index?.[0])
  })
})

describe('chats and the folder registry', () => {
  it("keeps a folder's chats when it is untracked, and shows them again when it is tracked again", () => {
    const fs = memoryFs()
    const registry = createFolderRegistry({ file: resolve('/state/folders.json'), homeDir: '', fs: registryFsOver(fs) })
    const store = openStore(fs)
    const chat = store.createChat({ ...NEW_CHAT, folder: registry.track(REPO).folder.path })
    store.appendItem(chat, userMessage('remember me'))

    registry.untrack(REPO)
    expect(registry.has(REPO)).toBe(false)
    expect(chatIds(openStore(fs), REPO)).toEqual([chat.id])

    const again = registry.track(REPO).folder.path
    expect(chatIds(openStore(fs), again)).toEqual([chat.id])
    expect(transcriptTexts(openStore(fs), again, chat.id)).toEqual(['remember me'])
  })

  it('still lists the chats of a folder that no longer exists on disk', () => {
    const fs = memoryFs()
    const chat = openStore(fs).createChat(NEW_CHAT)
    fs.dirs.delete(REPO)
    expect(chatIds(openStore(fs), REPO)).toEqual([chat.id])
  })
})

function realShapedToken(): { token: string; secret: string } {
  const random = (size: number): Buffer => Buffer.from(Array.from({ length: size }, (_, index) => (index * 53 + 5) % 256))
  const ids = createIdGenerator(() => 1_700_000_000_000, random)
  const secret = ids.secret()
  return { token: `${ids.next('attempt')}.${secret}`, secret }
}

describe('chat store masks claim tokens', () => {
  const { token, secret } = realShapedToken()

  function everythingStored(fs: MemoryFs): string {
    return [...fs.files.values()].join('\n')
  }

  it('masks a token in message text before it is stored or returned', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    const stored = store.appendItem(chat, { id: 'm', at: AT, kind: 'user_message', text: `claimToken: ${token}` })
    expect(stored).toMatchObject({ text: `claimToken: ${CLAIM_TOKEN_MASK}` })
    expect(everythingStored(fs)).not.toContain(secret)
    expect(JSON.stringify(openStore(fs).readTranscript(chat))).not.toContain(secret)
  })

  it('masks a token nested inside tool input and in tool results', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    const stored = store.appendItem(chat, {
      id: 'c',
      at: AT,
      kind: 'tool_call',
      name: 'Agent',
      input: { prompt: `heartbeat with ${token}`, packet: { claimToken: token, steps: [{ env: { TOKEN: token } }] } },
      status: 'completed',
      resultSummary: `used ${token}`
    })
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(everythingStored(fs)).not.toContain(secret)
    expect(stored).toMatchObject({ input: { packet: { claimToken: CLAIM_TOKEN_MASK } } })
  })

  it('masks a token in errors, approval requests, and the chat title', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat({ ...NEW_CHAT, title: `Worker ${token}` })
    store.updateChat(chat, { title: `Worker again ${token}` })
    store.appendItem(chat, { id: 'e', at: AT, kind: 'error', message: `bad ${token}` })
    const request = { id: 'r', at: AT, kind: 'approval_request', requestId: 'q', category: 'command', tool: 'Bash', summary: token, input: { command: token } } as const
    store.appendItem(chat, request)
    expect(everythingStored(fs)).not.toContain(secret)
    expect(store.listChats(REPO)[0]?.title).toBe(`Worker again ${CLAIM_TOKEN_MASK}`)
  })
})

describe('chat store on the real filesystem', () => {
  it('round-trips through files under the chats root', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chats-')))
    const root = join(base, 'agents', 'chats')
    try {
      const folder = join(base, 'repo')
      mkdirSync(folder)
      const chat = createChatStore({ root }).createChat({ ...NEW_CHAT, folder: join(base, 'repo', '..', 'repo') })
      createChatStore({ root }).appendItem(chat, userMessage('on disk'))
      expect(chat.folder).toBe(folder)

      const reopened = createChatStore({ root })
      expect(transcriptTexts(reopened, join(folder, sep), chat.id)).toEqual(['on disk'])
      const [key = ''] = readdirSync(root)
      expect(readdirSync(join(root, key)).sort()).toEqual([`${chat.id}.jsonl`, 'index.jsonl'].sort())
      expect(readFileSync(join(root, key, `${chat.id}.jsonl`), 'utf8').endsWith('\n')).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
