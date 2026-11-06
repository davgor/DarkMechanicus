import { rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { runCommand } from './processAdapters.js';

export interface Snapshots {
  /** Absolute paths of the snapshots, one per lane. */
  dirs: string[];
  /** Deletes every snapshot. */
  dispose: () => Promise<void>;
}

/** Snapshot roots still on disk, removed on process `exit` if a run ends without disposing them. */
const liveRoots = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const root of liveRoots) rmSync(root, { recursive: true, force: true });
  });
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand('git', args, { cwd, env });
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

/**
 * The `node_modules` directories every snapshot links to: each one git ignores (top-level and
 * nested), plus a top-level `node_modules` git does not ignore because it is a symlink.
 */
async function moduleDirs(cwd: string): Promise<string[]> {
  const args = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'];
  const dirs = (await git(cwd, args))
    .split('\0')
    .map((entry) => entry.replace(/\/$/, ''))
    .filter((entry) => entry === 'node_modules' || entry.endsWith('/node_modules'));
  if (!dirs.includes('node_modules') && (await exists(join(cwd, 'node_modules')))) {
    dirs.unshift('node_modules');
  }
  return dirs;
}

/** Committed symlinks (mode 120000) in the index at `env.GIT_INDEX_FILE`. */
async function committedLinks(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const entries = await git(cwd, ['ls-files', '-z', '--stage'], env);
  return entries
    .split('\0')
    .filter((entry) => entry.startsWith('120000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1));
}

/**
 * Points a committed absolute link into the workspace at the same path in the snapshot, so a
 * mutant written through it cannot reach the working tree.
 */
async function repointLink(cwd: string, dir: string, file: string): Promise<void> {
  const link = join(dir, file);
  const stats = await lstat(link).catch(() => undefined);
  if (!stats?.isSymbolicLink()) return;
  const target = await readlink(link);
  const inWorkspace = relative(cwd, target);
  if (!isAbsolute(target) || inWorkspace.startsWith('..') || isAbsolute(inWorkspace)) return;
  await unlink(link);
  await symlink(join(dir, inWorkspace), link);
}

async function fillSnapshot(
  cwd: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  links: { modules: string[]; committed: string[] }
): Promise<void> {
  // checkout-index wants a trailing slash and copes best with forward slashes on Windows.
  const prefix = `${dir.split(sep).join('/')}/`;
  await git(cwd, ['checkout-index', '--all', '--force', `--prefix=${prefix}`], env);
  await mkdir(dir, { recursive: true });
  for (const file of links.committed) await repointLink(cwd, dir, file);
  for (const modules of links.modules) {
    const link = join(dir, modules);
    if (await exists(link)) continue;
    await mkdir(dirname(link), { recursive: true });
    // A junction needs no privileges on Windows; other platforms ignore the type.
    await symlink(join(cwd, modules), link, 'junction');
  }
}

/**
 * Makes `count` snapshots of the committed tree (HEAD) in a temporary directory: every file as
 * it was committed, so uncommitted edits, untracked files and ignored files (build output) are
 * left out, with each `node_modules` linked to the working tree's rather than copied. Tests run
 * in a snapshot grade exactly what was committed, and a mutant written into one never touches
 * the working tree or another snapshot. Uses a temporary index, so the repository's own index
 * and worktree list are untouched.
 */
export async function snapshotCommittedTree(options: {
  cwd: string;
  count: number;
}): Promise<Snapshots> {
  const { cwd } = options;
  // Resolve the temp dir itself (on macOS /var is a link to /private/var) so test paths are stable.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fireguard-')));
  installExitHook();
  liveRoots.add(root);
  const dispose = async (): Promise<void> => {
    liveRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(root, 'index') };
    await git(cwd, ['read-tree', 'HEAD'], env);
    const links = { modules: await moduleDirs(cwd), committed: await committedLinks(cwd, env) };
    const dirs = Array.from({ length: options.count }, (_, index) =>
      join(root, `lane-${index + 1}`)
    );
    // Settle every snapshot before failing, so nothing writes into the root after dispose.
    const outcomes = await Promise.allSettled(
      dirs.map((dir) => fillSnapshot(cwd, dir, env, links))
    );
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (failed) throw failed.reason;
    return { dirs, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
