import { describe, it, expect } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotCommittedTree } from '../src/snapshots.js';
import { git, initRepo, withTempDir } from './support.js';

/** A committed repo whose working tree then differs from HEAD in every way a snapshot ignores. */
async function seedRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(dir, 'packages', 'p', 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(dir, '.gitignore'), 'out/\nnode_modules/\n');
  await writeFile(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src/gone.ts'), 'export const gone = 1;\n');
  await writeFile(join(dir, 'packages/p/index.ts'), 'export const p = 1;\n');
  await writeFile(join(dir, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  await writeFile(join(dir, 'packages/p/node_modules/dep/index.js'), 'module.exports = 2;\n');
  initRepo(dir);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
  await writeFile(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  await writeFile(join(dir, 'src/new.ts'), 'export const fresh = 1;\n');
  await mkdir(join(dir, 'out'));
  await writeFile(join(dir, 'out/build.js'), 'built\n');
  await rm(join(dir, 'src/gone.ts'));
}

describe('snapshotCommittedTree', () => {
  it('snapshots HEAD, not the working tree, and links every ignored node_modules', async () => {
    await withTempDir(async (dir) => {
      await seedRepo(dir);
      const status = git(dir, 'status', '--porcelain');
      const snapshots = await snapshotCommittedTree({ cwd: dir, count: 2 });
      try {
        expect(snapshots.dirs).toHaveLength(2);
        expect(new Set(snapshots.dirs).size).toBe(2);
        for (const snap of snapshots.dirs) {
          expect(await readFile(join(snap, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
          expect(await readFile(join(snap, 'src/gone.ts'), 'utf8')).toBe('export const gone = 1;\n');
          expect(existsSync(join(snap, '.gitignore'))).toBe(true);
          expect(existsSync(join(snap, 'src/new.ts'))).toBe(false);
          expect(existsSync(join(snap, 'out'))).toBe(false);
          expect(existsSync(join(snap, '.git'))).toBe(false);
          expect(realpathSync(join(snap, 'node_modules'))).toBe(realpathSync(join(dir, 'node_modules')));
          expect(realpathSync(join(snap, 'packages/p/node_modules'))).toBe(
            realpathSync(join(dir, 'packages/p/node_modules'))
          );
        }
        await writeFile(join(snapshots.dirs[0]!, 'src/a.ts'), 'mutant\n');
        expect(await readFile(join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
        expect(await readFile(join(snapshots.dirs[1]!, 'src/a.ts'), 'utf8')).toBe(
          'export const a = 1;\n'
        );
      } finally {
        await snapshots.dispose();
      }
      expect(snapshots.dirs.some((snap) => existsSync(snap))).toBe(false);
      expect(existsSync(join(dir, 'node_modules/pkg/index.js'))).toBe(true);
      expect(existsSync(join(dir, 'packages/p/node_modules/dep/index.js'))).toBe(true);
      // The repository's own index and working tree are untouched.
      expect(git(dir, 'status', '--porcelain')).toBe(status);
    });
  });

  it('links a top-level node_modules that git does not ignore, such as a link', async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, 'repo');
      await mkdir(join(repo, 'src'), { recursive: true });
      await mkdir(join(dir, 'shared-modules', 'pkg'), { recursive: true });
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
      await writeFile(join(repo, 'src/a.ts'), 'export const a = 1;\n');
      initRepo(repo);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'seed');
      // A junction needs no privileges on Windows; elsewhere it is a plain symlink.
      await symlink(join(dir, 'shared-modules'), join(repo, 'node_modules'), 'junction');
      const snapshots = await snapshotCommittedTree({ cwd: repo, count: 1 });
      try {
        expect(realpathSync(join(snapshots.dirs[0]!, 'node_modules'))).toBe(
          realpathSync(join(dir, 'shared-modules'))
        );
        expect(existsSync(join(snapshots.dirs[0]!, 'src/a.ts'))).toBe(true);
      } finally {
        await snapshots.dispose();
      }
    });
  });

  it('points committed absolute links into the workspace at the snapshot', async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, 'repo');
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src/a.ts'), 'export const a = 1;\n');
      await symlink(join(repo, 'src/a.ts'), join(repo, 'src/link.ts'));
      initRepo(repo);
      // Check links out as links even where git's default (as on Windows runners) is plain files.
      git(repo, 'config', 'core.symlinks', 'true');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'seed');
      const snapshots = await snapshotCommittedTree({ cwd: repo, count: 1 });
      try {
        await writeFile(join(snapshots.dirs[0]!, 'src/link.ts'), 'mutant\n');
        expect(await readFile(join(snapshots.dirs[0]!, 'src/a.ts'), 'utf8')).toBe('mutant\n');
        expect(await readFile(join(repo, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      } finally {
        await snapshots.dispose();
      }
    });
  });

  it('fails outside a git work tree', async () => {
    await withTempDir(async (dir) => {
      await expect(snapshotCommittedTree({ cwd: dir, count: 1 })).rejects.toThrow(/git read-tree/);
    });
  });
});
