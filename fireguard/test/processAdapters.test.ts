import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  createMutationApplier,
  createVitestRunner,
  getChangedLines,
  getGitDiffEntries,
  parseChangedLines,
  readCommittedFile,
  readWorkspaceFileSync,
  workspaceFileExists,
} from '../src/processAdapters.js';
import { git, initRepo, withTempDir } from './support.js';

describe('createMutationApplier', () => {
  it('restores original source after applying a mutant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fireguard-'));
    const rel = 'mod.ts';
    const absolute = join(dir, rel);
    const original = 'export const n = 1;\n';
    await writeFile(absolute, original, 'utf8');

    const seen: string[] = [];
    const applyAndTest = createMutationApplier({
      cwd: dir,
      runOnce: async () => {
        seen.push(await readFile(absolute, 'utf8'));
        return { ok: false };
      },
    });

    const result = await applyAndTest({
      file: rel,
      originalSource: original,
      mutatedSource: 'export const n = 2;\n',
      relatedTests: ['mod.test.ts'],
    });

    expect(result.ok).toBe(false);
    expect(seen).toEqual(['export const n = 2;\n']);
    expect(await readFile(absolute, 'utf8')).toBe(original);
  });

  it('treats mutants as survived when no related tests exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fireguard-'));
    const rel = 'mod.ts';
    await writeFile(join(dir, rel), 'export const n = 1;\n', 'utf8');
    const applyAndTest = createMutationApplier({
      cwd: dir,
      runOnce: async () => ({ ok: false }),
    });
    const result = await applyAndTest({
      file: rel,
      originalSource: 'export const n = 1;\n',
      mutatedSource: 'export const n = 2;\n',
      relatedTests: [],
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, rel), 'utf8')).toBe('export const n = 1;\n');
  });
});

describe('createVitestRunner worker cap', () => {
  it('hands maxWorkers to the test command as VITEST_MAX_WORKERS', async () => {
    const testCommand = "node -e process.exit(process.env.VITEST_MAX_WORKERS==='3'?0:7)";
    const config = { ...DEFAULT_CONFIG, testCommand };
    const capped = createVitestRunner({ cwd: process.cwd(), config, maxWorkers: 3 });
    expect(await capped(['x.test.ts'])).toEqual({ ok: true });
    const other = createVitestRunner({ cwd: process.cwd(), config, maxWorkers: 2 });
    expect((await other(['x.test.ts'])).ok).toBe(false);
  });

  it('adds --passWithNoTests and --bail=1 to mutant runs only', async () => {
    // `--` makes node hand the flags to the script instead of parsing them as its own options.
    const testCommand =
      "node -e process.exit(process.argv.slice(-3).join()==='--passWithNoTests,--bail=1,x.spec.ts'?0:9) --";
    const config = { ...DEFAULT_CONFIG, testCommand };
    const lenient = createVitestRunner({ cwd: process.cwd(), config, mutantRun: true });
    expect(await lenient(['x.spec.ts'])).toEqual({ ok: true });
    const strict = createVitestRunner({ cwd: process.cwd(), config });
    expect((await strict(['x.spec.ts'])).ok).toBe(false);
  });
});

async function withWorkspace(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fireguard-probe-'));
  try {
    await mkdir(join(dir, 'src', 'dir'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('workspace file probes', () => {
  it('reports regular files only', async () => {
    await withWorkspace((dir) => {
      expect(workspaceFileExists(dir, 'src/a.ts')).toBe(true);
      expect(workspaceFileExists(dir, 'src/dir')).toBe(false);
      expect(workspaceFileExists(dir, 'src/missing.ts')).toBe(false);
      expect(workspaceFileExists(dir, 'src/a.ts/child')).toBe(false);
    });
  });

  it('reads files synchronously and returns null when they cannot be read', async () => {
    await withWorkspace((dir) => {
      expect(readWorkspaceFileSync(dir, 'src/a.ts')).toBe('export const a = 1;\n');
      expect(readWorkspaceFileSync(dir, 'src/missing.ts')).toBeNull();
      expect(readWorkspaceFileSync(dir, 'src/dir')).toBeNull();
    });
  });
});

describe('createMutationApplier change reports', () => {
  it('reports each write of the module: the mutant, then the restored original', async () => {
    await withWorkspace(async (dir) => {
      const changed: string[] = [];
      const applyAndTest = createMutationApplier({
        cwd: dir,
        runOnce: async () => {
          changed.push('run');
          return { ok: true };
        },
        changed: (file) => changed.push(file),
      });
      await applyAndTest({
        file: 'src/a.ts',
        originalSource: 'export const a = 1;\n',
        mutatedSource: 'export const a = 2;\n',
        relatedTests: ['src/a.test.ts'],
      });
      expect(changed).toEqual(['src/a.ts', 'run', 'src/a.ts']);
    });
  });
});

describe('parseChangedLines', () => {
  it('collects the new-side lines of each hunk, per file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3 @@ export',
      '-old',
      '+new',
      '@@ -10,0 +11,2 @@',
      '+one',
      '+two',
      '@@ -20,3 +22,0 @@',
      '-gone',
      'diff --git a/src/new name.ts b/src/new name.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new name.ts\t',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '',
    ].join('\n');
    expect(parseChangedLines(diff)).toEqual(
      new Map([
        ['src/a.ts', new Set([3, 11, 12])],
        ['src/new name.ts', new Set([1, 2])],
      ])
    );
  });
});

describe('committed reads and diffs', () => {
  it('see only what was committed, never the working tree', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await mkdir(join(dir, 'src'));
      await writeFile(join(dir, 'src/a.ts'), 'one\ntwo\nthree\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'base');
      const baseRef = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'src/a.ts'), 'one\nTWO\nthree\nfour\n');
      await writeFile(join(dir, 'src/b.ts'), 'b\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'change');
      await writeFile(join(dir, 'src/a.ts'), 'uncommitted\n');
      await writeFile(join(dir, 'src/c.ts'), 'untracked\n');

      expect(await readCommittedFile(dir, 'src/a.ts')).toBe('one\nTWO\nthree\nfour\n');
      await expect(readCommittedFile(dir, 'src/c.ts')).rejects.toThrow(/git show HEAD:src\/c.ts/);
      expect(await getGitDiffEntries({ cwd: dir, baseRef })).toEqual([
        { status: 'M', path: 'src/a.ts' },
        { status: 'A', path: 'src/b.ts' },
      ]);
      expect(await getChangedLines({ cwd: dir, baseRef, paths: ['src/a.ts'] })).toEqual(
        new Map([['src/a.ts', new Set([2, 4])]])
      );
      expect(await getChangedLines({ cwd: dir, baseRef, paths: [] })).toEqual(new Map());
    });
  });

  it('fall back to base..HEAD when the histories share no merge base', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, 'a.ts'), 'a\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'base');
      const baseRef = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '-q', '--orphan', 'other');
      await writeFile(join(dir, 'a.ts'), 'A\n');
      await writeFile(join(dir, 'b.ts'), 'b\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'unrelated');
      await writeFile(join(dir, 'c.ts'), 'uncommitted\n');
      git(dir, 'add', 'c.ts');
      expect(await getGitDiffEntries({ cwd: dir, baseRef })).toEqual([
        { status: 'M', path: 'a.ts' },
        { status: 'A', path: 'b.ts' },
      ]);
    });
  });
});
