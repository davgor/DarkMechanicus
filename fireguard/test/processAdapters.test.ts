import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMutationApplier,
  readWorkspaceFileSync,
  workspaceFileExists,
} from '../src/processAdapters.js';

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
