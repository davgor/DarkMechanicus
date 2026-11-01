import { constants, rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { runCommand } from './processAdapters.js';

export interface WorkspaceCopies {
  /** Absolute paths of the copies, one per lane. */
  dirs: string[];
  /** Deletes every copy. */
  dispose: () => Promise<void>;
}

/** Copy roots still on disk, removed on process `exit` if a run ends without disposing them. */
const liveRoots = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const root of liveRoots) rmSync(root, { recursive: true, force: true });
  });
}

/**
 * Tracked and untracked-but-not-ignored files, as the working tree has them now. The top-level
 * `node_modules` is left out even when git lists it (a symlink is not matched by a
 * `node_modules/` ignore rule): every copy links it instead.
 */
async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const result = await runCommand('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  const files = result.stdout
    .split('\0')
    .filter((file) => file && file !== 'node_modules' && !file.startsWith('node_modules/'));
  return [...new Set(files)];
}

/**
 * Copies one file or symlink into a copy; a path git lists but the working tree no longer has
 * is skipped. An absolute link into the workspace is pointed at the same path in the copy, so a
 * mutant written through it cannot reach the original.
 */
async function copyEntry(cwd: string, dir: string, file: string): Promise<void> {
  const from = join(cwd, file);
  const to = join(dir, file);
  const stats = await lstat(from).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (stats === undefined) return;
  await mkdir(dirname(to), { recursive: true });
  if (stats.isSymbolicLink()) {
    const target = await readlink(from);
    const inWorkspace = relative(cwd, target);
    const local =
      isAbsolute(target) && !inWorkspace.startsWith('..') && !isAbsolute(inWorkspace)
        ? join(dir, inWorkspace)
        : target;
    await symlink(local, to);
  } else if (stats.isFile()) {
    // Copy-on-write clone where the filesystem supports it (APFS, btrfs), plain copy elsewhere.
    await copyFile(from, to, constants.COPYFILE_FICLONE);
  }
}

/** How many files are copied at once, to stay well under open-file limits. */
const COPY_BATCH = 64;

/**
 * Makes `count` copies of the workspace in a temporary directory: every file git tracks or
 * would track (deleted files left out, ignored files such as build output left out), with
 * `node_modules` linked to the original rather than copied. Tests run in a copy see the
 * working tree as it is now, and a mutant written into a copy never touches the original.
 */
export async function copyWorkspace(options: {
  cwd: string;
  count: number;
}): Promise<WorkspaceCopies> {
  const files = await listWorkspaceFiles(options.cwd);
  // Resolve the temp dir itself (on macOS /var is a link to /private/var) so test paths are stable.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fireguard-')));
  installExitHook();
  liveRoots.add(root);
  const dispose = async (): Promise<void> => {
    liveRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  };
  try {
    const dirs = Array.from({ length: options.count }, (_, index) =>
      join(root, `lane-${index + 1}`)
    );
    const copies = dirs.flatMap((dir) => files.map((file) => ({ dir, file })));
    for (let start = 0; start < copies.length; start += COPY_BATCH) {
      // Settle the whole batch before failing, so nothing writes into the root after dispose.
      const outcomes = await Promise.allSettled(
        copies
          .slice(start, start + COPY_BATCH)
          .map(({ dir, file }) => copyEntry(options.cwd, dir, file))
      );
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      if (failed) throw failed.reason;
    }
    const modules = join(options.cwd, 'node_modules');
    const hasModules = await lstat(modules).then(
      () => true,
      () => false
    );
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      // A junction needs no privileges on Windows; other platforms ignore the type.
      if (hasModules) await symlink(modules, join(dir, 'node_modules'), 'junction');
    }
    return { dirs, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
