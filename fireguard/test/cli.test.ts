import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import type { FireguardReport } from '../src/types.js';

describe('runCli', () => {
  it('prints help and exits 0', async () => {
    let out = '';
    const code = await runCli({
      cwd: process.cwd(),
      argv: ['--help'],
      stdout: (text) => {
        out += text;
      },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(out).toContain('fireguard');
    expect(out).toContain('Exit codes');
    expect(out).toContain('--comment-pr');
  });
});

const skipped: FireguardReport = {
  grade: { letter: 'A', score: 100, reasons: ['no graded unit tests to evaluate'] },
  gates: {},
  scope: { baseRef: 'main', gradedTestFiles: [], changedModules: [] },
  skipped: true,
  skipReason: 'No added/modified unit tests vs base ref',
};

describe('runCli production dependencies', () => {
  it('wires workspace file probes so mutation runs can be scoped by imports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fireguard-cli-'));
    try {
      await mkdir(join(dir, 'src', 'dir'), { recursive: true });
      await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
      const probes: Array<boolean | string | null | undefined> = [];
      const code = await runCli({
        cwd: dir,
        argv: [],
        env: {},
        stdout: () => undefined,
        stderr: () => undefined,
        runFireguardFn: async (deps) => {
          probes.push(deps.fileExists?.('src/a.ts'), deps.fileExists?.('src/dir'));
          probes.push(deps.readFileSync?.('src/a.ts'), deps.readFileSync?.('src/none.ts'));
          return skipped;
        },
      });
      expect(code).toBe(0);
      expect(probes).toEqual([true, false, 'export const a = 1;\n', null]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
