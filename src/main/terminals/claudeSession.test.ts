/**
 * Whether Claude Code has written a chat's session: its transcript file under the configuration folder, which is
 * what `claude --resume <id>` reads. Checked on the real disk, in a scratch home folder.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { claudeProjectName, claudeSessionExists } from './claudeSession'

const SESSION = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0'
const FOLDER = '/private/tmp/My Repo_2.0'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dm-claude-session-')))
})

afterEach(() => {
  removeScratch(home)
})

function writeSession(config: string, project: string, id = SESSION): void {
  mkdirSync(join(config, 'projects', project), { recursive: true })
  writeFileSync(join(config, 'projects', project, `${id}.jsonl`), '{"type":"user"}\n')
}

describe('claudeProjectName', () => {
  it('names the folder as Claude Code does: every character but a letter or digit becomes -', () => {
    expect(claudeProjectName('/private/tmp/dm326-probe/repo')).toBe('-private-tmp-dm326-probe-repo')
    expect(claudeProjectName(FOLDER)).toBe('-private-tmp-My-Repo-2-0')
    expect(claudeProjectName('C:\\Users\\me\\repo')).toBe('C--Users-me-repo')
  })
})

describe('claudeSessionExists', () => {
  it('is false until the session file is in the folder’s project, then true', () => {
    const env = { HOME: home }
    expect(claudeSessionExists({ env, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(false)

    writeSession(join(home, '.claude'), claudeProjectName(FOLDER))

    expect(claudeSessionExists({ env, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(true)
  })

  it('does not take another session’s file, or a folder named like the session, for it', () => {
    writeSession(join(home, '.claude'), claudeProjectName(FOLDER), '11111111-2222-4333-8444-555555555555')
    mkdirSync(join(home, '.claude', 'projects', claudeProjectName(FOLDER), `${SESSION}.jsonl`), { recursive: true })

    expect(claudeSessionExists({ env: { HOME: home }, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(false)
  })

  it('finds the file in another project folder too (Claude Code shortens the name of a long path)', () => {
    writeSession(join(home, '.claude'), `${claudeProjectName(FOLDER).slice(0, 10)}-1a2b3c`)

    expect(claudeSessionExists({ env: { HOME: home }, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(true)
  })

  it('looks in CLAUDE_CONFIG_DIR when it is set, read from the folder when relative, and not in ~/.claude', () => {
    writeSession(join(home, '.claude'), claudeProjectName(FOLDER))
    const moved = join(home, 'moved')
    expect(claudeSessionExists({ env: { HOME: home, CLAUDE_CONFIG_DIR: moved }, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(false)

    writeSession(moved, claudeProjectName(FOLDER))
    expect(claudeSessionExists({ env: { HOME: home, CLAUDE_CONFIG_DIR: ` ${moved} ` }, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(true)
    expect(claudeSessionExists({ env: { HOME: '/nowhere', CLAUDE_CONFIG_DIR: 'moved' }, platform: 'darwin', folder: home, sessionId: SESSION })).toBe(true)
  })

  it('reads the home folder from USERPROFILE on Windows', () => {
    writeSession(join(home, '.claude'), claudeProjectName(FOLDER))

    expect(claudeSessionExists({ env: { USERPROFILE: home, HOME: '/nowhere' }, platform: 'win32', folder: FOLDER, sessionId: SESSION })).toBe(true)
  })

  it('is false for an id that could name a path, and when there is no configuration folder', () => {
    writeSession(join(home, '.claude'), claudeProjectName(FOLDER), 'x')
    for (const sessionId of ['../x', 'x', '']) {
      expect(claudeSessionExists({ env: { HOME: home }, platform: 'darwin', folder: FOLDER, sessionId })).toBe(false)
    }
    expect(claudeSessionExists({ env: { HOME: join(home, 'none') }, platform: 'darwin', folder: FOLDER, sessionId: SESSION })).toBe(false)
  })
})
