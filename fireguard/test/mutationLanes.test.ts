import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { openMutationLanes } from '../src/mutationLanes.js';
import { copyWorkspace, type WorkspaceCopies } from '../src/workspaceCopies.js';
import type { FireguardConfig, RunOnceResult, TestRunner } from '../src/types.js';

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fireguard-lanes-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=fg', '-c', 'user.email=fg@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

/** A git repo whose working tree differs from HEAD in every way copies must reproduce. */
async function seedRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'out'));
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(dir, '.gitignore'), 'out/\nnode_modules/\n');
  await writeFile(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src/gone.ts'), 'export const gone = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
  await writeFile(join(dir, 'src/a.ts'), 'export const a = 2;\n');
  await writeFile(join(dir, 'src/new.ts'), 'export const fresh = 1;\n');
  await writeFile(join(dir, 'out/build.js'), 'built\n');
  await writeFile(join(dir, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  await rm(join(dir, 'src/gone.ts'));
}

describe('copyWorkspace', () => {
  it('copies the working tree as git sees it and shares node_modules', async () => {
    await withTempDir(async (dir) => {
      await seedRepo(dir);
      const copies = await copyWorkspace({ cwd: dir, count: 2 });
      try {
        expect(copies.dirs).toHaveLength(2);
        expect(new Set(copies.dirs).size).toBe(2);
        for (const copy of copies.dirs) {
          expect(await readFile(join(copy, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
          expect(await readFile(join(copy, 'src/new.ts'), 'utf8')).toBe('export const fresh = 1;\n');
          expect(existsSync(join(copy, '.gitignore'))).toBe(true);
          expect(existsSync(join(copy, 'src/gone.ts'))).toBe(false);
          expect(existsSync(join(copy, 'out'))).toBe(false);
          expect(realpathSync(join(copy, 'node_modules'))).toBe(
            realpathSync(join(dir, 'node_modules'))
          );
        }
        await writeFile(join(copies.dirs[0]!, 'src/a.ts'), 'mutant\n');
        expect(await readFile(join(dir, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
        expect(await readFile(join(copies.dirs[1]!, 'src/a.ts'), 'utf8')).toBe(
          'export const a = 2;\n'
        );
      } finally {
        await copies.dispose();
      }
      expect(copies.dirs.some((copy) => existsSync(copy))).toBe(false);
      expect(existsSync(join(dir, 'node_modules/pkg/index.js'))).toBe(true);
    });
  });

  it('links node_modules even when git lists it, as with a symlinked node_modules', async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, 'repo');
      await mkdir(join(repo, 'src'), { recursive: true });
      await mkdir(join(dir, 'shared-modules', 'pkg'), { recursive: true });
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
      await writeFile(join(repo, 'src/a.ts'), 'export const a = 1;\n');
      git(repo, 'init', '-q');
      await symlink(join(dir, 'shared-modules'), join(repo, 'node_modules'));
      const copies = await copyWorkspace({ cwd: repo, count: 1 });
      try {
        expect(realpathSync(join(copies.dirs[0]!, 'node_modules'))).toBe(
          realpathSync(join(dir, 'shared-modules'))
        );
        expect(existsSync(join(copies.dirs[0]!, 'src/a.ts'))).toBe(true);
      } finally {
        await copies.dispose();
      }
    });
  });

  it('points absolute links into the workspace at the copy, so writes stay in the copy', async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, 'repo');
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src/a.ts'), 'export const a = 1;\n');
      await symlink(join(repo, 'src/a.ts'), join(repo, 'src/link.ts'));
      git(repo, 'init', '-q');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'seed');
      const copies = await copyWorkspace({ cwd: repo, count: 1 });
      try {
        await writeFile(join(copies.dirs[0]!, 'src/link.ts'), 'mutant\n');
        expect(await readFile(join(copies.dirs[0]!, 'src/a.ts'), 'utf8')).toBe('mutant\n');
        expect(await readFile(join(repo, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      } finally {
        await copies.dispose();
      }
    });
  });

  it('fails outside a git work tree', async () => {
    await withTempDir(async (dir) => {
      await expect(copyWorkspace({ cwd: dir, count: 1 })).rejects.toThrow(/git ls-files/);
    });
  });
});

const MODULE = 'src/m.ts';
const ORIGINAL = 'export const m = 1;\n';
const MUTANT = 'export const m = 2;\n';

interface RunnerCall {
  dir: string;
  workers: number | undefined;
  files: string[];
  source: string;
}

/** Fake runners that record where they ran and what the module held at the time. */
function recordingRunners(result: (dir: string) => RunOnceResult) {
  const calls: RunnerCall[] = [];
  const created: Array<{ dir: string; workers: number | undefined }> = [];
  const runnerFor = (dir: string, workers: number | undefined): TestRunner => {
    created.push({ dir, workers });
    return async (files) => {
      calls.push({ dir, workers, files, source: await readFile(join(dir, MODULE), 'utf8') });
      return result(dir);
    };
  };
  return { calls, created, runnerFor };
}

async function workspaceWithModule(dir: string, name: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, MODULE), ORIGINAL);
  return root;
}

/** Fake copier over real directories, so appliers write real files. */
function fakeCopies(dir: string) {
  const state = { disposed: 0, requested: [] as number[] };
  const copy = async (count: number): Promise<WorkspaceCopies> => {
    state.requested.push(count);
    const dirs: string[] = [];
    for (let i = 0; i < count; i += 1) dirs.push(await workspaceWithModule(dir, `copy-${i}`));
    return {
      dirs,
      dispose: async () => {
        state.disposed += 1;
      },
    };
  };
  return { state, copy };
}

const MUTANT_RUN = {
  file: MODULE,
  originalSource: ORIGINAL,
  mutatedSource: MUTANT,
  relatedTests: ['src/m.test.ts'],
};

function withConcurrency(concurrency: number): FireguardConfig {
  return { ...DEFAULT_CONFIG, concurrency };
}

describe('openMutationLanes in place', () => {
  it('mutates the working tree one mutant at a time when concurrency is 1', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const { calls, runnerFor } = recordingRunners(() => ({ ok: false }));
      const { state, copy } = fakeCopies(dir);
      const lanes = await openMutationLanes({
        cwd,
        config: withConcurrency(1),
        gradedTests: ['src/m.test.ts'],
        copy,
        runnerFor,
      });
      expect(lanes.execution).toEqual({ lanes: 1, workspace: 'in-place' });
      expect(lanes.appliers).toHaveLength(1);
      expect(await lanes.appliers[0]!(MUTANT_RUN)).toEqual({ ok: false });
      expect(calls).toEqual([
        { dir: cwd, workers: undefined, files: ['src/m.test.ts'], source: MUTANT },
      ]);
      expect(await readFile(join(cwd, MODULE), 'utf8')).toBe(ORIGINAL);
      expect(state.requested).toEqual([]);
    });
  });

  it('lets a mutant batch vitest collects no tests from pass rather than count as a kill', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      // `--` makes node hand the flag to the script instead of parsing it as its own option.
      const testCommand = "node -e process.exit(process.argv.includes('--passWithNoTests')?0:9) --";
      const lanes = await openMutationLanes({
        cwd,
        config: { ...withConcurrency(1), testCommand },
        gradedTests: ['src/m.spec.ts'],
      });
      const result = await lanes.appliers[0]!({ ...MUTANT_RUN, relatedTests: ['src/m.spec.ts'] });
      expect(result).toEqual({ ok: true });
    });
  });
});

describe('openMutationLanes with workspace copies', () => {
  it('opens one capped lane per copy after an uncapped baseline run in a copy', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const { calls, created, runnerFor } = recordingRunners(() => ({ ok: true }));
      const { state, copy } = fakeCopies(dir);
      const graded = ['src/m.test.ts', 'src/other.test.ts'];
      const lanes = await openMutationLanes({
        cwd,
        config: withConcurrency(3),
        gradedTests: graded,
        copy,
        runnerFor,
        cpus: 12,
      });
      const copyDirs = [0, 1, 2].map((i) => join(dir, `copy-${i}`));
      expect(lanes.execution).toEqual({ lanes: 3, workspace: 'copies' });
      expect(state.requested).toEqual([3]);
      expect(created).toEqual([
        { dir: copyDirs[0], workers: undefined },
        ...copyDirs.map((copyDir) => ({ dir: copyDir, workers: 4 })),
      ]);
      expect(calls).toEqual([
        { dir: copyDirs[0], workers: undefined, files: graded, source: ORIGINAL },
      ]);

      await lanes.appliers[2]!(MUTANT_RUN);
      expect(calls[1]).toEqual({
        dir: copyDirs[2],
        workers: 4,
        files: ['src/m.test.ts'],
        source: MUTANT,
      });
      expect(await readFile(join(cwd, MODULE), 'utf8')).toBe(ORIGINAL);
      expect(await readFile(join(copyDirs[2]!, MODULE), 'utf8')).toBe(ORIGINAL);

      expect(state.disposed).toBe(0);
      await lanes.close();
      expect(state.disposed).toBe(1);
    });
  });

  it('falls back to the working tree when the graded tests fail in a copy', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const { calls, runnerFor } = recordingRunners((runDir) =>
        runDir === cwd ? { ok: false } : { ok: false, error: 'fatal: not a git repository' }
      );
      const { state, copy } = fakeCopies(dir);
      const lanes = await openMutationLanes({
        cwd,
        config: withConcurrency(2),
        gradedTests: ['src/m.test.ts'],
        copy,
        runnerFor,
        cpus: 8,
      });
      expect(state.disposed).toBe(1);
      expect(lanes.execution.workspace).toBe('in-place');
      expect(lanes.execution.lanes).toBe(1);
      expect(lanes.execution.fallbackReason).toContain('fatal: not a git repository');
      expect(lanes.appliers).toHaveLength(1);
      await lanes.appliers[0]!(MUTANT_RUN);
      expect(calls.at(-1)).toEqual({
        dir: cwd,
        workers: undefined,
        files: ['src/m.test.ts'],
        source: MUTANT,
      });
    });
  });

  it('falls back to the working tree when the workspace cannot be copied', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const { calls, runnerFor } = recordingRunners(() => ({ ok: false }));
      const lanes = await openMutationLanes({
        cwd,
        config: withConcurrency(4),
        gradedTests: ['src/m.test.ts'],
        copy: async () => {
          throw new Error('ENOSPC: no space left on device');
        },
        runnerFor,
      });
      expect(lanes.execution.workspace).toBe('in-place');
      expect(lanes.execution.fallbackReason).toContain('ENOSPC');
      expect(calls).toEqual([]);
      await lanes.appliers[0]!(MUTANT_RUN);
      expect(calls.map((call) => call.dir)).toEqual([cwd]);
    });
  });
});
