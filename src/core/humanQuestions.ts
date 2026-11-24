import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from './db/database'
import { fail } from './errors'
import { humanWaitCurrent } from '../../resources/skitarii/extension/humanWaitLease'

export const HUMAN_QUESTION_GUIDANCE = 'Ask in the conversation while the human is engaging with you. Use ask_human only when you need a human response to proceed AND the human is currently not engaging with you in this conversation. When both conditions hold and Telegram is enabled and paired, send the question once and use get_human_answer to read the reply. A normal pause between turns does not establish disengagement. Keep progress and completion updates in the conversation. If Telegram is unavailable, leave the question in the conversation. Disengagement is never consent.'

interface HumanAnswer { state: string; answer: string | null }
const directory = 'human-questions'
const filename = 'questions.sqlite'
export function questionStore(home: string): Db {
  mkdirSync(join(home, directory), { recursive: true, mode: 0o700 })
  const db = openDatabase(join(home, directory, filename))
  db.exec(`CREATE TABLE IF NOT EXISTS channel (id INTEGER PRIMARY KEY, available INTEGER, heartbeat INTEGER);
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, question TEXT NOT NULL, state TEXT NOT NULL,
      recipient TEXT, message INTEGER, answer TEXT, created INTEGER NOT NULL
    );`)
  return db
}

function available(db: Db): boolean {
  return !!db.get('SELECT 1 FROM channel WHERE id=1 AND available=1 AND heartbeat>?', Date.now() - 60000)
}

export function telegramAvailable(home: string): boolean {
  if (!existsSync(join(home, directory, filename))) return false
  const db = questionStore(home)
  try { return available(db) } finally { db.close() }
}

export function publishChannel(db: Db, enabled: boolean): void {
  db.tx(() => {
    db.run('INSERT OR REPLACE INTO channel VALUES (1,?,?)', Number(enabled), Date.now())
    if (!enabled) db.run("UPDATE questions SET state='cancelled' WHERE state IN ('queued','wait_queued')")
  })
}

export function askHuman(home: string, repo: string, question: string, waitId?: string): { questionId: string; state: 'queued' } {
  const db = questionStore(home)
  try {
    return db.tx(() => {
      if (!available(db)) fail('operation_unavailable', 'Telegram is unavailable. Ask in the conversation.')
      if (waitId !== undefined && !humanWaitCurrent(home, waitId)) fail('operation_unavailable', 'This human wait has ended; do not send a reminder.')
      const id = waitId ?? randomUUID()
      const row = db.run('INSERT OR IGNORE INTO questions(id,repo,question,state,created) VALUES (?,?,?,?,?)',
        id, repo, question, waitId === undefined ? 'queued' : 'wait_queued', Date.now())
      if (!row.changes) fail('conflict', 'This human wait already has a contact attempt. Do not send another.')
      return { questionId: id, state: 'queued' as const }
    })
  } finally { db.close() }
}

export function humanAnswer(home: string, repo: string, id: string): HumanAnswer {
  const db = questionStore(home)
  try {
    return db.get<HumanAnswer>("SELECT CASE state WHEN 'wait_queued' THEN 'queued' ELSE state END AS state,answer FROM questions WHERE id=? AND repo=?", id, repo)
      ?? fail('not_found', 'Unknown human question.')
  } finally { db.close() }
}
