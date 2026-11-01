/**
 * Fetch, pull (merge, never rebase) and push (publishing a branch without an upstream, never forcing) against
 * the sync remote, with progress events and cancel by operation id. GitHub HTTPS remotes use the signed-in
 * account's token through `credentialArgs`; everything else uses the machine's own credentials.
 */
import type { GitProgressEvent } from '../../shared/git/api'
import type { RepoState } from '../../shared/git/status'
import { credentialArgs, type CredentialSession, isGithubHttps, sshPromptEnv } from './credentials'
import { GitError, GitInputError } from './errors'
import { parseProgressLine } from './progress'
import { resolveSyncRemote, type SyncRemote } from './remotes'
import type { GitRunner } from './runner'
import { readRepository, readRepoState } from './status'

export type SyncOperation = 'fetch' | 'pull' | 'push'

interface SyncDeps {
  runner: GitRunner
  session: CredentialSession
  onProgress(event: GitProgressEvent): void
  /** Where the person's own ssh settings are read from; `process.env` in the app. */
  env?: NodeJS.ProcessEnv
}

export interface Sync {
  /** Runs `operation` in the repository `folder` is in and returns the state afterwards. */
  run(operation: SyncOperation, folder: string, operationId: string): Promise<RepoState>
  /** Aborts the running operation `operationId` in `folder`, which then fails `cancelled`; false if none runs. */
  cancel(folder: string, operationId: string): boolean
}

interface Run {
  operation: SyncOperation
  folder: string
  operationId: string
  signal: AbortSignal
  /** Called once git has finished: a cancel after that has nothing left to stop. */
  gitDone(): void
}

/**
 * Push: to the upstream when it has the branch's own name (or to a separate push remote under that name);
 * otherwise, with no upstream or one under another name (`git switch -c topic origin/main`), publish the branch
 * under its own name and make that the upstream. Never a refspec onto a differently named branch, never forced.
 */
function pushArgs(target: SyncRemote, local: string): string[] {
  const pushRemote = target.pushRemote.name
  const triangular = target.upstreamRef !== null && pushRemote !== target.remote.name
  return triangular || target.upstreamRef === local
    ? ['push', '--progress', '--', pushRemote, local]
    : ['push', '--progress', '--set-upstream', '--', pushRemote, local]
}

/** The git command for `operation`. */
function commandArgs(operation: SyncOperation, target: SyncRemote, branch: string | null): string[] {
  // `git pull` hands the remote to `git fetch` without the `--`, so a name like `-x` would turn into an option.
  if ([target.remote.name, target.pushRemote.name].some((name) => name.startsWith('-'))) {
    throw new GitInputError('A remote whose name starts with "-" cannot be used here. Rename it first.')
  }
  if (operation === 'fetch') {
    return ['fetch', '--prune', '--progress', '--', target.remote.name]
  }
  if (branch === null) {
    throw new GitInputError('Switch to a branch first: a detached HEAD cannot be pulled or pushed.')
  }
  const local = `refs/heads/${branch}`
  if (operation === 'pull') {
    return ['pull', '--no-rebase', '--no-edit', '--progress', '--', target.remote.name, target.upstreamRef ?? local]
  }
  return pushArgs(target, local)
}

/** Progress lines become events; a line repeating the last phase and percentage is dropped. */
function progressSink(deps: SyncDeps, run: Run): (line: string) => void {
  let last = ''
  return (line) => {
    const parsed = parseProgressLine(line)
    if (parsed === null || `${parsed.phase}\0${String(parsed.percent)}` === last) {
      return
    }
    last = `${parsed.phase}\0${String(parsed.percent)}`
    deps.onProgress({ folder: run.folder, operationId: run.operationId, operation: run.operation, ...parsed })
  }
}

/**
 * Signed in, a rejection by github.com means the token no longer works; signed out on GitHub HTTPS, it means
 * sign in. A rejection by another host (a submodule's) keeps git's own code.
 */
function authFailure(error: unknown, usedToken: boolean, githubHttps: boolean): unknown {
  const fromGithub = error instanceof GitError && /github\.com/i.test(error.detail)
  if (!(error instanceof GitError) || (error.code !== 'auth_required' && error.code !== 'auth_failed') || !fromGithub) {
    return error
  }
  if (usedToken) {
    return new GitError('auth_failed', error.detail, 'GitHub rejected the signed-in account; it may have been revoked. Sign in to GitHub again.')
  }
  return githubHttps ? new GitError('auth_required', error.detail, 'Sign in to GitHub to use this remote.') : error
}

async function configuredSshCommand(runner: GitRunner, root: string): Promise<string | null> {
  const result = await runner.run({ cwd: root, args: ['config', '--get', 'core.sshCommand'], kind: 'read', acceptExitCodes: [0, 1] })
  const value = result.stdout.trim()
  return result.code === 0 && value !== '' ? value : null
}

export type NetworkDeps = Pick<SyncDeps, 'runner' | 'session' | 'env'>

interface NetworkAuth {
  /** `-c` options to put before the git command. */
  args: string[]
  env: Record<string, string>
  redact: string[]
  /** The error to report for a failed run: a GitHub rejection becomes `auth_failed` or `auth_required`. */
  failure(error: unknown): unknown
}

/** How a network git against `url` authenticates: the account's token for GitHub HTTPS, ssh in batch mode. */
export async function networkAuth(deps: NetworkDeps, root: string, url: string): Promise<NetworkAuth> {
  const credentials = credentialArgs(url, deps.session)
  const ssh = sshPromptEnv(await configuredSshCommand(deps.runner, root), deps.env ?? process.env)
  return {
    args: credentials?.args ?? [],
    env: { ...ssh, ...credentials?.env },
    redact: credentials?.secrets ?? [],
    failure: (error) => authFailure(error, credentials !== null, isGithubHttps(url))
  }
}

async function runOperation(deps: SyncDeps, run: Run): Promise<RepoState> {
  const status = await readRepository(deps.runner, run.folder)
  const target = await resolveSyncRemote(deps.runner, status.root, status.branch.name)
  const command = commandArgs(run.operation, target, status.branch.name)
  const auth = await networkAuth(deps, status.root, run.operation === 'push' ? target.pushRemote.pushUrl : target.remote.fetchUrl)
  try {
    await deps.runner.run({
      cwd: status.root,
      args: [...auth.args, ...command],
      kind: 'network',
      env: auth.env,
      redact: auth.redact,
      signal: run.signal,
      onProgress: progressSink(deps, run)
    })
  } catch (error) {
    throw auth.failure(error)
  } finally {
    run.gitDone()
  }
  return readRepoState(deps.runner, run.folder)
}

export function createSync(deps: SyncDeps): Sync {
  const running = new Map<string, AbortController>()
  const keyOf = (folder: string, operationId: string): string => `${folder}\0${operationId}`
  return {
    async run(operation, folder, operationId) {
      const key = keyOf(folder, operationId)
      if (running.has(key)) {
        throw new GitInputError('An operation with that id is already running.')
      }
      // Registered before the first await, so a cancel sent right after the start still finds it.
      const controller = new AbortController()
      running.set(key, controller)
      const forget = (): void => {
        if (running.get(key) === controller) {
          running.delete(key)
        }
      }
      try {
        return await runOperation(deps, { operation, folder, operationId, signal: controller.signal, gitDone: forget })
      } finally {
        forget()
      }
    },
    cancel(folder, operationId) {
      const controller = running.get(keyOf(folder, operationId))
      controller?.abort()
      return controller !== undefined
    }
  }
}
