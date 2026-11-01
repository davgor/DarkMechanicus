/**
 * Whether Claude Code has written a chat's session yet (`docs/design/chat-shells.md`, "Resume"): main starts a
 * Claude chat with `--session-id <uuid>` and later with `--resume <uuid>`, and `--resume` of a session Claude
 * never wrote fails every time. Claude writes a session as `<config>/projects/<project>/<uuid>.jsonl` once the
 * session holds a message, not when the CLI starts: a chat that exited at the folder-trust prompt, or that was
 * stopped before its first prompt, has no file (checked live with Claude Code 2.1.291, DM-326).
 *
 * Why the file and not a flag set on the first input: the first input is often the answer to the folder-trust
 * prompt, and "No, exit" leaves no session; the file is what `--resume` reads, so it also answers for a session
 * deleted since, and for an old chat's stored id.
 *
 * `<config>` is `CLAUDE_CONFIG_DIR` from main's environment (which the terminal inherits; a relative one is read
 * from the chat's folder, the CLI's cwd), else `~/.claude`. `<project>` is the folder with every character but a
 * letter or digit made `-`; Claude shortens the name of a long path, so every project folder is looked in when the
 * folder's own has no file (a session id is a UUID main generated, so a file of that name is the chat's).
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ClaudeSessionQuery {
  /** The environment the CLI is started with (main's own). */
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  /** The chat's folder, the CLI's cwd. */
  folder: string
  sessionId: string
}

/** The name Claude Code gives a folder's project under `<config>/projects`. */
export function claudeProjectName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-')
}

function configFolder(query: ClaudeSessionQuery): string {
  const moved = query.env['CLAUDE_CONFIG_DIR']?.trim() ?? ''
  if (moved !== '') {
    return resolve(query.folder, moved)
  }
  const home = (query.platform === 'win32' ? query.env['USERPROFILE'] : query.env['HOME']) ?? homedir()
  return join(home, '.claude')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function projectFolders(projects: string): string[] {
  try {
    return readdirSync(projects)
  } catch {
    return []
  }
}

export function claudeSessionExists(query: ClaudeSessionQuery): boolean {
  if (!UUID.test(query.sessionId)) {
    return false
  }
  const projects = join(configFolder(query), 'projects')
  const file = `${query.sessionId}.jsonl`
  return isFile(join(projects, claudeProjectName(query.folder), file)) || projectFolders(projects).some((project) => isFile(join(projects, project, file)))
}
