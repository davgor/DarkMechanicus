import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { createIdGenerator } from '../../core/ids'
import { chatItemSchema, type ChatItem } from '../../shared/agents/chat'
import { createFolderRegistry, type RegistryFs } from '../desktop/folderRegistry'
import { storeItems } from './__mocks__/chatFixtures'
import { CHAT_BEFORE_THREADS, CHAT_BEFORE_THREADS_LINES } from './__mocks__/chatBeforeThreads'
import { CLAIM_TOKEN_MASK } from './claimTokenMask'
import { createChatStore, type ChatRef, type ChatStore, type ChatStoreFs, type NewChat } from './chatStore'

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

/** Stores items in the chat's transcript as an app from before terminals wrote them. */
function stored(fs: ChatStoreFs, chat: ChatRef, items: readonly ChatItem[]): void {
  storeItems(fs, chat, items, ROOT)
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

  it('reads the items an old app stored, in order, from a fresh store over the same files', () => {
    const fs = memoryFs()
    const chat = openStore(fs).createChat(NEW_CHAT)
    stored(fs, chat, [userMessage('one'), userMessage('two'), { id: 'a', at: AT, kind: 'assistant_text', text: 'three' }])

    const reopened = openStore(fs)
    expect(chatIds(reopened, REPO)).toEqual([chat.id])
    const transcript = reopened.readTranscript(chat)
    expect(transcript?.chat.id).toBe(chat.id)
    expect(transcript?.skipped).toBe(0)
    expect(transcriptTexts(reopened, REPO, chat.id)).toEqual(['one', 'two', 'assistant_text'])
  })

  it('writes no transcript for a chat: a new chat has none to read', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    store.updateChat(chat, { title: 'Renamed', grantIds: ['gr_1'] })

    expect([...fs.files.keys()].map((path) => path.split(sep).at(-1))).toEqual(['index.jsonl'])
    expect(store.readTranscript(chat)?.items).toEqual([])
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

  it('keeps the epic a transfer chat moves to Linear across a reopen, and a chat without one has none', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const transfer = store.createChat({ ...NEW_CHAT, role: 'orchestrator', transferEpicId: 'ep_1' })
    const plain = store.createChat(NEW_CHAT)
    store.updateChat(transfer, { sessionId: 'session_1' })

    const reopened = openStore(fs)
    expect(reopened.getChat(transfer)).toMatchObject({ role: 'orchestrator', transferEpicId: 'ep_1', sessionId: 'session_1' })
    expect(reopened.getChat(plain)).not.toHaveProperty('transferEpicId')
  })
})

describe('chat store item replacement', () => {
  it('lets a later line with the same id replace the earlier one in place', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    const call = { id: 'call_1', at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'ls' } } as const
    stored(fs, chat, [{ ...call, status: 'running', resultSummary: null }, userMessage('between'), { ...call, status: 'completed', resultSummary: '2 files' }])
    const items = openStore(fs).readTranscript(chat)?.items ?? []
    expect(items.map((item) => item.kind)).toEqual(['tool_call', 'user_message'])
    expect(items[0]).toMatchObject({ status: 'completed', resultSummary: '2 files' })
  })
})

describe('chat store nested threads', () => {
  const thread = { id: 'claude_thread_t1', at: AT, kind: 'thread', parentItemId: 'claude_tool_t1', label: 'Summarize a.txt' } as const
  const call = { id: 'claude_tool_t1', at: AT, kind: 'tool_call', name: 'Agent', input: {} } as const
  const inner = { id: 'claude_tool_r1', at: AT, kind: 'tool_call', name: 'Read', input: {}, threadId: thread.id } as const

  it('reads a thread with its items, the thread keeping its place while its state changed', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    stored(fs, chat, [
      { ...call, status: 'running', resultSummary: null },
      { ...thread, state: 'running' },
      { ...inner, status: 'running', resultSummary: null },
      { ...inner, status: 'completed', resultSummary: 'ok' },
      { ...call, status: 'completed', resultSummary: 'done' },
      { ...thread, state: 'done' }
    ])

    const transcript = openStore(fs).readTranscript(chat)

    expect(transcript?.skipped).toBe(0)
    expect(transcript?.items.map((item) => [item.id, item.kind, item.threadId])).toEqual([
      ['claude_tool_t1', 'tool_call', undefined],
      ['claude_thread_t1', 'thread', undefined],
      ['claude_tool_r1', 'tool_call', 'claude_thread_t1']
    ])
    expect(transcript?.items[1]).toMatchObject({ parentItemId: 'claude_tool_t1', label: 'Summarize a.txt', state: 'done' })
    expect(transcript?.items[2]).toMatchObject({ status: 'completed', resultSummary: 'ok' })
  })
})

describe('chat store reads chats stored before threads existed', () => {
  function storedBeforeThreads(): { fs: MemoryFs; chat: { folder: string; id: string } } {
    const fs = memoryFs()
    const chat = openStore(fs).createChat(NEW_CHAT)
    fs.files.set(indexPath(fs).replace('index.jsonl', `${chat.id}.jsonl`), CHAT_BEFORE_THREADS)
    return { fs, chat }
  }

  it('loads every item of a transcript in the old shape, without threads', () => {
    const { fs, chat } = storedBeforeThreads()

    const transcript = openStore(fs).readTranscript(chat)

    expect(transcript?.skipped).toBe(0)
    expect(transcript?.items.map((item) => [item.id, item.kind])).toEqual([
      ['it_1', 'user_message'],
      ['claude_tool_toolu_old1', 'tool_call'],
      ['claude_tool_toolu_old2', 'tool_call'],
      ['claude_approval_toolu_oldw', 'approval_request'],
      ['item_dec_1', 'approval_decision'],
      ['claude_msg_old_0', 'assistant_text']
    ])
    expect(transcript?.items.some((item) => item.threadId !== undefined || item.kind === 'thread')).toBe(false)
    expect(transcript?.items[1]).toMatchObject({ name: 'Agent', status: 'completed', resultSummary: 'Alpha lists three fruits.' })
    expect(transcript?.items[3]).not.toHaveProperty('threadLabel')
  })

  it('accepts every stored line against the current contract as it is', () => {
    expect(CHAT_BEFORE_THREADS_LINES.map((line) => chatItemSchema.safeParse(JSON.parse(line)).success)).toEqual(CHAT_BEFORE_THREADS_LINES.map(() => true))
  })
})

describe('chat store reads index lines written before agents had ids', () => {
  it('loads an "agent":"cursor" line unchanged and does not rewrite the index', () => {
    const fs = memoryFs()
    const created = openStore(fs).createChat(NEW_CHAT)
    const line = JSON.stringify({
      id: 'ch_old_cursor',
      folder: created.folder,
      agent: 'cursor',
      model: null,
      role: 'worker',
      allowSave: false,
      title: 'Old cursor chat',
      createdAt: AT,
      updatedAt: AT,
      sessionId: 'sess-1'
    })
    expect(line).toContain('"agent":"cursor"')
    fs.files.set(indexPath(fs), `${line}\n`)

    const chats = openStore(fs).listChats(created.folder)

    expect(chats).toEqual([JSON.parse(line)])
    expect(fs.files.get(indexPath(fs))).toBe(`${line}\n`)
  })
})

describe('chat store reads chats stored before terminals', () => {
  /** A record and its transcript as the app wrote them before chats were terminals (the epic's start commit, live). */
  function oldChat(fs: MemoryFs): { line: string; transcript: string; folder: string } {
    const created = openStore(fs).createChat(NEW_CHAT)
    const line = JSON.stringify({
      id: 'chat_ddd10bef-7606-4919-9971-3c7f2f61a8a1',
      folder: created.folder,
      agent: 'claude',
      model: 'haiku',
      role: 'planner',
      allowSave: true,
      title: 'Old SDK chat',
      createdAt: '2026-10-31T16:44:41.336Z',
      updatedAt: '2026-10-31T16:45:16.535Z',
      sessionId: '42eb1ddb-3b32-4ca9-9352-918f157b9ad7'
    })
    const transcript = [
      '{"id":"item_e454e7c8-9436-4fea-926d-238c65472bd8","at":"2026-10-31T16:45:14.188Z","kind":"user_message","text":"Remember the code word OSPREY. Reply with exactly: OK, noted."}',
      '{"id":"claude_msg_011CgaeojEot2Zffg1SqsGti_0","at":"2026-10-31T16:45:16.535Z","kind":"assistant_text","text":"OK, noted."}'
    ].join('\n')
    fs.files.set(indexPath(fs), `${line}\n`)
    fs.files.set(indexPath(fs).replace('index.jsonl', 'chat_ddd10bef-7606-4919-9971-3c7f2f61a8a1.jsonl'), `${transcript}\n`)
    return { line, transcript, folder: created.folder }
  }

  it('loads a record with no grant ids, kickoff or started flag unchanged: none issued, none sent, none started', () => {
    const fs = memoryFs()
    const { line, folder } = oldChat(fs)

    const [chat] = openStore(fs).listChats(folder)

    expect(chat).toEqual(JSON.parse(line))
    expect([chat?.grantIds ?? [], chat?.sessionStarted === true, 'kickoffSent' in (chat ?? {})]).toEqual([[], false, false])
  })

  it('keeps every old field when a terminal start stores its first grant, and leaves the old transcript as it was', () => {
    const fs = memoryFs()
    const { line, transcript, folder } = oldChat(fs)
    const store = openStore(fs)
    const ref = { folder, id: 'chat_ddd10bef-7606-4919-9971-3c7f2f61a8a1' }

    store.updateChat(ref, { grantIds: ['gr_1'] })

    const reopened = openStore(fs)
    expect(reopened.getChat(ref)).toEqual({ ...JSON.parse(line), grantIds: ['gr_1'], updatedAt: expect.any(String) })
    expect(reopened.readTranscript(ref)?.items.map((item) => item.kind)).toEqual(['user_message', 'assistant_text'])
    expect(fs.files.get(transcriptPath(fs, ref.id))).toBe(`${transcript}\n`)
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
    store.updateChat(first, { title: 'bumps it' })
    expect(chatIds(store, REPO)).toEqual([first.id, second.id])
  })

  it('refuses to update a chat it does not know', () => {
    const store = openStore(memoryFs())
    const ghost = { folder: REPO, id: 'chat_ghost' }
    expect(errorCode(() => store.updateChat(ghost, { title: 'x' }))).toBe('not_found')
    expect(store.getChat(ghost)).toBeNull()
    expect(store.readTranscript(ghost)).toBeNull()
  })

  it('rejects a relative folder', () => {
    expect(errorCode(() => openStore(memoryFs()).createChat({ ...NEW_CHAT, folder: 'repo' }))).toBe('invalid_input')
  })

  it('refuses a record the chat contract does not accept, saying what is wrong, and stores nothing', () => {
    const fs = memoryFs()
    const store = openStore(fs)

    expect(() => store.createChat({ ...NEW_CHAT, model: '' })).toThrow(/^Invalid chat: /)
    expect(errorCode(() => store.createChat({ ...NEW_CHAT, model: '' }))).toBe('invalid_input')
    expect(openStore(fs).listChats(REPO)).toEqual([])
  })
})

describe('chat store reads', () => {
  function seeded(): { fs: MemoryFs; chat: { folder: string; id: string }; path: string } {
    const fs = memoryFs()
    const chat = openStore(fs).createChat(NEW_CHAT)
    stored(fs, chat, [userMessage('one'), userMessage('two')])
    return { fs, chat, path: transcriptPath(fs, chat.id) }
  }

  it('skips a truncated final line', () => {
    const { fs, chat, path } = seeded()
    fs.files.set(path, `${fs.files.get(path) ?? ''}{"id":"it_9","at":"2026-02-01T00:00:00.000Z","kind":"user_mess`)
    const transcript = openStore(fs).readTranscript(chat)
    expect(transcript?.items).toHaveLength(2)
    expect(transcript?.skipped).toBe(1)
  })

  it('skips an item of unknown kind and keeps the rest of the chat', () => {
    const { fs, chat, path } = seeded()
    const future = JSON.stringify({ id: 'f1', at: AT, kind: 'subagent_spawn', threadId: 't1' })
    fs.files.set(path, `${fs.files.get(path) ?? ''}${future}\n`)
    const reopened = openStore(fs)
    expect(transcriptTexts(reopened, REPO, chat.id)).toEqual(['one', 'two'])
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
    isDirectory: (path) => fs.dirs.has(path),
    readdir: () => [],
    isSymlink: () => false
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
    stored(fs, chat, [userMessage('via the link')])
    expect(transcriptTexts(store, resolve('/work/link'), chat.id)).toEqual(['via the link'])
  })

  it('keeps folders apart', () => {
    const store = openStore(memoryFs())
    const mine = store.createChat(NEW_CHAT)
    const theirs = store.createChat({ ...NEW_CHAT, folder: OTHER })
    expect(chatIds(store, REPO)).toEqual([mine.id])
    expect(chatIds(store, OTHER)).toEqual([theirs.id])
    expect(store.getChat({ folder: OTHER, id: mine.id })).toBeNull()
  })

  it('keeps a folder under a filesystem-safe folder key, with its index and one transcript file per chat', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat(NEW_CHAT)
    stored(fs, chat, [userMessage('x')])
    const paths = [...fs.files.keys()].map((path) => path.slice(ROOT.length + 1).split(sep))
    expect(paths).toHaveLength(2)
    const index = paths.find((parts) => parts[1] === 'index.jsonl')
    const transcript = paths.find((parts) => parts[1] === `${chat.id}.jsonl`)
    expect(index?.[0]).toMatch(/^[0-9a-f]{24}$/)
    expect(transcript?.[0]).toBe(index?.[0])
    expect(transcriptTexts(store, REPO, chat.id)).toEqual(['x'])
  })
})

describe('chats and the folder registry', () => {
  it("keeps a folder's chats when it is untracked, and shows them again when it is tracked again", () => {
    const fs = memoryFs()
    const registry = createFolderRegistry({ dmHome: resolve('/state/dm-home'), file: resolve('/state/folders.json'), homeDir: '', fs: registryFsOver(fs) })
    const store = openStore(fs)
    const chat = store.createChat({ ...NEW_CHAT, folder: registry.track(REPO).folder.path })
    stored(fs, chat, [userMessage('remember me')])

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

  it('masks a token in the chat title before it is stored or returned', () => {
    const fs = memoryFs()
    const store = openStore(fs)
    const chat = store.createChat({ ...NEW_CHAT, title: `Worker ${token}` })
    store.updateChat(chat, { title: `Worker again ${token}` })
    expect([...fs.files.values()].join('\n')).not.toContain(secret)
    expect(chat.title).toBe(`Worker ${CLAIM_TOKEN_MASK}`)
    expect(store.listChats(REPO)[0]?.title).toBe(`Worker again ${CLAIM_TOKEN_MASK}`)
  })
})

describe('chat store on the real filesystem', () => {
  it('round-trips through files under the chats root, reading a transcript an old app left next to the index', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chats-')))
    const root = join(base, 'agents', 'chats')
    try {
      const folder = join(base, 'repo')
      mkdirSync(folder)
      const chat = createChatStore({ root }).createChat({ ...NEW_CHAT, folder: join(base, 'repo', '..', 'repo') })
      expect(chat.folder).toBe(folder)
      const [key = ''] = readdirSync(root)
      expect(readdirSync(join(root, key))).toEqual(['index.jsonl'])
      appendFileSync(join(root, key, `${chat.id}.jsonl`), `${JSON.stringify(userMessage('on disk'))}\n`)

      const reopened = createChatStore({ root })
      expect(reopened.getChat({ folder: join(folder, sep), id: chat.id })).toEqual(chat)
      expect(transcriptTexts(reopened, join(folder, sep), chat.id)).toEqual(['on disk'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
