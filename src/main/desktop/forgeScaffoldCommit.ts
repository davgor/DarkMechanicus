import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ForgeGit } from './forgeGit'

interface ForgeCodeCommit {
  root: string
  files: { path: string; content: string }[]
  author: string
  assertCurrent(): void
}

function gitBlob(content: string): string {
  return createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0').update(content).digest('hex')
}

function allowedDirectories(files: Map<string, string>): Set<string> {
  const directories = new Set<string>()
  for (const file of files.keys()) {
    const parts = file.split('/')
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join('/'))
  }
  return directories
}

function checkDirectory(root: string, files: Map<string, string>, directories: Set<string>, parent = ''): void {
  for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
    const path = parent ? parent + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      if (path === '.git') continue
      if (!directories.has(path)) throw new Error('The scaffold directory contains an unexpected folder.')
      checkDirectory(root, files, directories, path)
    } else if (!entry.isFile() || !files.has(path)) {
      throw new Error('The scaffold directory contains an unexpected file.')
    }
  }
}

function gitEntries(output: string, files: Map<string, string>, kind: 'index' | 'commit', complete: boolean): void {
  const entries = output.split('\0').filter(Boolean)
  const digest = '[a-f0-9]{40}'
  const match = kind === 'index' ? new RegExp('^100644 (' + digest + ') 0\\t(.+)$') : new RegExp('^100644 blob (' + digest + ')\\t(.+)$')
  const seen = new Set<string>()
  for (const raw of entries) {
    const entry = match.exec(raw)
    if (!entry || seen.has(entry[2]) || files.get(entry[2]) !== entry[1]) throw new Error('The scaffold Git ' + kind + ' includes unexpected content.')
    seen.add(entry[2])
  }
  if (complete && seen.size !== files.size) throw new Error('The scaffold Git ' + kind + ' is incomplete.')
}

/** Only publish the exact initialized tree, including when a previous process stopped between staging and pushing. */
export async function commitForgeScaffold(git: Pick<ForgeGit, 'run'>, options: ForgeCodeCommit): Promise<string> {
  const { root, author, assertCurrent } = options
  const files = new Map(options.files.map(file => [file.path, gitBlob(file.content)]))
  const guard = { beforeStart: assertCurrent }
  const run = (args: string[]) => git.run(root, args, undefined, guard)
  const readIndex = async () => (await run(['ls-files', '--stage', '-z'])).stdout
  const head = await git.run(root, ['rev-parse', '--verify', 'HEAD'], undefined, { ...guard, acceptExitCodes: [0, 128] })
  assertCurrent()
  checkDirectory(root, files, allowedDirectories(files))
  gitEntries(await readIndex(), files, 'index', false)
  if (head.code !== 0) {
    const pathspec = [...files.keys()].join('\0') + '\0'
    await git.run(root, ['--literal-pathspecs', '-c', 'core.autocrlf=false', 'add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'],
      undefined, { ...guard, stdin: pathspec })
    gitEntries(await readIndex(), files, 'index', true)
    await run(['-c', 'user.name=' + author, '-c', 'user.email=' + author + '@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize BoosterSeat scaffold'])
  }
  const history = (await run(['rev-list', '--max-count=2', 'HEAD'])).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(history)) throw new Error('The scaffold Git history is not an initial commit.')
  gitEntries((await run(['ls-tree', '-r', '-z', history])).stdout, files, 'commit', true)
  const status = await run(['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.stdout !== '') throw new Error('The code checkout has changes outside the recorded scaffold. Review it before resuming.')
  return history
}
