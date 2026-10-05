/**
 * App-wide store of agent chats (`userData/agents/chats`), one directory per folder:
 *
 *   <root>/<folder key>/index.jsonl     one line per chat-record change; the last line per id wins
 *   <root>/<folder key>/<chat id>.jsonl one `ChatItem` per line, in the order they happened
 *
 * The folder key is a hash of the folder's canonical real path (the same canonical form the folder
 * registry uses), so every spelling of a folder finds the same chats, and untracking a folder never
 * touches them. Files are only ever appended to, with one exception: deleting a chat removes its
 * transcript file and rewrites the folder index without any line of that chat (an atomic replace),
 * so nothing of a deleted chat, not even an earlier title, stays on disk. Reads skip any line that
 * is not a valid record or item (a truncated last line, or a kind a newer version wrote) instead of
 * failing the chat.
 *
 * Everything is masked for claim tokens before it is written, and the masked item is what
 * `appendItem` returns, so the session manager emits exactly what was stored.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { z } from 'zod'
import { DomainError } from '../../core/errors'
import { chatItemSchema, chatRecordSchema, type ChatItem, type ChatRecord } from '../../shared/agents/chat'
import { canonicalPath } from '../desktop/folderRegistry'
import { maskClaimTokensDeep } from './claimTokenMask'

/** The filesystem surface the store uses; tests inject fakes through it. */
export interface ChatStoreFs {
  /** Whole file as text; throws when it does not exist. */
  readFile(path: string): string
  appendFile(path: string, data: string): void
  /** Deletes a file; one that is already gone is not an error. */
  removeFile(path: string): void
  /** Replaces a file's whole content so that a reader (or a crash) sees the old text or the new, never a mix. */
  replaceFile(path: string, data: string): void
  mkdirp(path: string): void
  /** Canonical real path; throws when the path does not exist. */
  realpath(path: string): string
}

/** What a caller supplies to start a chat; the store assigns the id, timestamps and session id. */
export type NewChat = Pick<ChatRecord, 'folder' | 'agent' | 'model' | 'role' | 'allowSave'> & { title?: string; runId?: string }

/** Identifies a chat: its folder (any spelling) and id. Every `ChatRecord` is one. */
export type ChatRef = Pick<ChatRecord, 'folder' | 'id'>

type ChatPatch = Partial<Pick<ChatRecord, 'title' | 'model' | 'role' | 'allowSave' | 'sessionId' | 'cutShortMessageId'>>

interface ChatTranscript {
  chat: ChatRecord
  /** Items in the order first written; a later line with the same id replaced the earlier content. */
  items: ChatItem[]
  /** Lines that were not valid items (truncated, or of an unknown kind) and were left out. */
  skipped: number
}

export interface ChatStore {
  createChat(input: NewChat): ChatRecord
  /** A folder's chats, most recently updated first; empty for a folder with none. */
  listChats(folder: string): ChatRecord[]
  getChat(ref: ChatRef): ChatRecord | null
  /** Changes chat fields and stamps `updatedAt`; throws `not_found` for an unknown chat. */
  updateChat(ref: ChatRef, patch: ChatPatch): ChatRecord
  /** Masks, validates and appends an item, returning what was stored; throws `not_found`/`invalid_input`. */
  appendItem(ref: ChatRef, item: ChatItem): ChatItem
  /** The chat and its transcript; null for an unknown chat. */
  readTranscript(ref: ChatRef): ChatTranscript | null
  /** Removes the chat, its transcript and every stored version of its record; throws `not_found` for an unknown chat. */
  deleteChat(ref: ChatRef): void
}

const DEFAULT_TITLE = 'New chat'

const INDEX_FILE = 'index.jsonl'

/** Items that arrive in bursts inside a turn; they do not rewrite the index to bump `updatedAt`. */
const QUIET_KINDS: ReadonlySet<ChatItem['kind']> = new Set(['tool_call', 'approval_request', 'approval_decision'])

const nodeChatStoreFs: ChatStoreFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  appendFile: (path, data) => {
    appendFileSync(path, data, 'utf8')
  },
  removeFile: (path) => {
    rmSync(path, { force: true })
  },
  replaceFile: (path, data) => {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, data, 'utf8')
    renameSync(temporary, path)
  },
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  realpath: (path) => realpathSync.native(path)
}

interface StoreContext {
  root: string
  fs: ChatStoreFs
  now: () => string
  newId: () => string
  /** Folder key -> the folder's chats by id, loaded from its index on first use. */
  indexes: Map<string, Map<string, ChatRecord>>
  /** Files whose tail was already checked for a truncated last line by this process. */
  checked: Set<string>
}

interface FolderLocation {
  /** Canonical folder path. */
  folder: string
  key: string
  dir: string
}

function validated<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new DomainError('invalid_input', `Invalid ${what}: ${result.error.issues[0]?.message ?? 'unknown problem'}`)
  }
  return result.data
}

/** The canonical folder path (as the folder registry computes it) and its on-disk key. */
function locate(context: StoreContext, folder: string): FolderLocation {
  if (!isAbsolute(folder)) {
    throw new DomainError('invalid_input', `Folder path must be absolute: ${folder}`)
  }
  // A folder that is gone still has chats; without a real path, the normalized spelling is all we have.
  const canonical = canonicalPath(context.fs, folder) ?? resolve(folder)
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24)
  return { folder: canonical, key, dir: join(context.root, key) }
}

/** The file's lines; a missing or unreadable file has none. */
function readLines(fs: ChatStoreFs, path: string): string[] {
  try {
    return fs.readFile(path).split('\n')
  } catch {
    return []
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** True when the file exists and its last line was cut short, so appending needs a fresh line. */
function endsMidLine(fs: ChatStoreFs, path: string): boolean {
  try {
    const text = fs.readFile(path)
    return text !== '' && !text.endsWith('\n')
  } catch {
    return false
  }
}

/** Appends one JSON line; the first append to a file per process first repairs a truncated tail. */
function appendLine(context: StoreContext, path: string, value: unknown): void {
  const { fs } = context
  let prefix = ''
  if (!context.checked.has(path)) {
    fs.mkdirp(dirname(path))
    prefix = endsMidLine(fs, path) ? '\n' : ''
  }
  fs.appendFile(path, `${prefix}${JSON.stringify(value)}\n`)
  context.checked.add(path)
}

function loadIndex(context: StoreContext, location: FolderLocation): Map<string, ChatRecord> {
  const cached = context.indexes.get(location.key)
  if (cached !== undefined) {
    return cached
  }
  const chats = new Map<string, ChatRecord>()
  for (const line of readLines(context.fs, join(location.dir, INDEX_FILE))) {
    const record = chatRecordSchema.safeParse(parseLine(line))
    if (record.success) {
      chats.set(record.data.id, record.data)
    }
  }
  context.indexes.set(location.key, chats)
  return chats
}

/** Writes a record to the index and the cache; a failed write leaves both unchanged. */
function saveRecord(context: StoreContext, location: FolderLocation, record: ChatRecord): ChatRecord {
  const stored = validated(chatRecordSchema, maskClaimTokensDeep(record), 'chat')
  const chats = loadIndex(context, location)
  appendLine(context, join(location.dir, INDEX_FILE), stored)
  chats.set(stored.id, stored)
  return stored
}

function requireChat(context: StoreContext, ref: ChatRef): { location: FolderLocation; chat: ChatRecord } {
  const location = locate(context, ref.folder)
  const chat = loadIndex(context, location).get(ref.id)
  if (chat === undefined) {
    throw new DomainError('not_found', `Chat not found: ${ref.id}`)
  }
  return { location, chat }
}

function createChat(context: StoreContext, input: NewChat): ChatRecord {
  const location = locate(context, input.folder)
  const now = context.now()
  return saveRecord(context, location, {
    id: context.newId(),
    folder: location.folder,
    agent: input.agent,
    model: input.model,
    role: input.role,
    allowSave: input.allowSave,
    title: input.title ?? DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    sessionId: null,
    ...(input.runId === undefined ? {} : { runId: input.runId })
  })
}

function byRecency(a: ChatRecord, b: ChatRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt)
}

function updateChat(context: StoreContext, ref: ChatRef, patch: ChatPatch): ChatRecord {
  const { location, chat } = requireChat(context, ref)
  const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  return saveRecord(context, location, { ...chat, ...changes, updatedAt: context.now() })
}

function appendItem(context: StoreContext, ref: ChatRef, item: ChatItem): ChatItem {
  const { location, chat } = requireChat(context, ref)
  const stored = validated(chatItemSchema, maskClaimTokensDeep(item), 'chat item')
  appendLine(context, join(location.dir, `${chat.id}.jsonl`), stored)
  if (!QUIET_KINDS.has(stored.kind)) {
    saveRecord(context, location, { ...chat, updatedAt: context.now() })
  }
  return stored
}

function readItems(fs: ChatStoreFs, path: string): { items: ChatItem[]; skipped: number } {
  const byId = new Map<string, ChatItem>()
  let skipped = 0
  for (const line of readLines(fs, path)) {
    if (line.trim() === '') {
      continue
    }
    const item = chatItemSchema.safeParse(parseLine(line))
    if (item.success) {
      byId.set(item.data.id, item.data)
    } else {
      skipped += 1
    }
  }
  return { items: [...byId.values()], skipped }
}

function readTranscript(context: StoreContext, ref: ChatRef): ChatTranscript | null {
  const location = locate(context, ref.folder)
  const chat = loadIndex(context, location).get(ref.id)
  if (chat === undefined) {
    return null
  }
  return { chat, ...readItems(context.fs, join(location.dir, `${chat.id}.jsonl`)) }
}

/** The index text without any line of chat `id`; every line ends in a newline, so a cut-off tail cannot swallow the next append. */
function indexWithout(text: string, id: string): string {
  const kept = text.split('\n').filter((line) => line.trim() !== '' && (parseLine(line) as { id?: unknown } | null)?.id !== id)
  return kept.map((line) => `${line}\n`).join('')
}

/**
 * Deletes the transcript first and the index lines second: a failure in between leaves a chat with an
 * empty transcript that can be deleted again, never a transcript that no chat points to.
 */
function deleteChat(context: StoreContext, ref: ChatRef): void {
  const { location, chat } = requireChat(context, ref)
  const transcript = join(location.dir, `${chat.id}.jsonl`)
  const index = join(location.dir, INDEX_FILE)
  context.fs.removeFile(transcript)
  context.fs.replaceFile(index, indexWithout(readLines(context.fs, index).join('\n'), chat.id))
  context.checked.delete(transcript)
  loadIndex(context, location).delete(chat.id)
}

export function createChatStore(options: {
  /** Absolute path of the chats directory (`userData/agents/chats`). */
  root: string
  fs?: ChatStoreFs
  /** ISO timestamp source for `createdAt` and `updatedAt`. */
  now?: () => string
  /** Chat id source; ids must be filesystem-safe (letters, digits, `_`, `-`). */
  newId?: () => string
}): ChatStore {
  const context: StoreContext = {
    root: options.root,
    fs: options.fs ?? nodeChatStoreFs,
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? (() => `chat_${randomUUID()}`),
    indexes: new Map(),
    checked: new Set()
  }
  return {
    createChat: (input) => createChat(context, input),
    listChats: (folder) => [...loadIndex(context, locate(context, folder)).values()].sort(byRecency),
    getChat: (ref) => loadIndex(context, locate(context, ref.folder)).get(ref.id) ?? null,
    updateChat: (ref, patch) => updateChat(context, ref, patch),
    appendItem: (ref, item) => appendItem(context, ref, item),
    readTranscript: (ref) => readTranscript(context, ref),
    deleteChat: (ref) => {
      deleteChat(context, ref)
    }
  }
}
