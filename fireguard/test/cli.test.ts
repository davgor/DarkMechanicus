import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import type { FireguardReport } from '../src/types.js';
import { git, initRepo, withTempDir } from './support.js';

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
  revision: { base: 'base-commit', head: 'head-commit' },
  grade: { letter: 'A', score: 100, reasons: ['no graded unit tests to evaluate'] },
  gates: {},
  scope: { baseRef: 'main', gradedTestFiles: [], changedModules: [] },
  skipped: true,
  skipReason: 'No added/modified unit tests vs base ref',
};

describe('runCli production dependencies', () => {
  it('grades what was committed: committed reads, changed lines, lanes over snapshots', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src/a.ts'), 'export const a = 1;\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      const committed = 'export const a = 1;\nexport const b = 2;\n';
      await writeFile(join(dir, 'src/a.ts'), committed);
      git(dir, 'commit', '-q', '-am', 'change');
      await writeFile(join(dir, 'src/a.ts'), 'uncommitted\n');
      const seen: unknown[] = [];
      const code = await runCli({
        cwd: dir,
        argv: [],
        env: { FIREGUARD_BASE_REF: base, FIREGUARD_CONCURRENCY: '2' },
        stdout: () => undefined,
        stderr: () => undefined,
        runFireguardFn: async (deps) => {
          seen.push(await deps.readFile('src/a.ts'));
          seen.push(await deps.getChangedLines?.(['src/a.ts']));
          const lanes = await deps.openLanes();
          try {
            const { source } = lanes;
            seen.push(await source.readFile('src/a.ts'));
            seen.push([source.fileExists?.('src/a.ts'), source.fileExists?.('src')]);
            seen.push(source.readFileSync?.('src/none.ts'), lanes.execution);
          } finally {
            await lanes.close();
          }
          return skipped;
        },
      });
      expect(code).toBe(0);
      expect(seen).toEqual([
        committed,
        new Map([['src/a.ts', new Set([2])]]),
        committed,
        [true, false],
        null,
        { lanes: 2, workspace: 'committed', runner: 'warm' },
      ]);
    });
  });

  it('resolves the same committed base and head for local and sharded reports', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, 'tracked.txt'), 'base');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'tracked.txt'), 'head');
      git(dir, 'commit', '-qam', 'head');
      const head = git(dir, 'rev-parse', 'HEAD');
      const run = async (argv: string[]): Promise<FireguardReport> => {
        let output = '';
        const code = await runCli({
          cwd: dir, argv: ['--json', ...argv],
          env: { FIREGUARD_BASE_REF: base },
          stdout: (text) => { output += text; },
        });
        expect(code).toBe(0);
        return JSON.parse(output) as FireguardReport;
      };
      const local = await run([]);
      const shard = await run(['--shard', '1/2']);
      expect(local.revision).toEqual({ base, head });
      expect(shard.revision).toEqual(local.revision);
      expect(shard.shard).toMatchObject({ base, head, index: 1, count: 2 });
      const second = await run(['--shard', '2/2']);
      const directory = join(dir, 'reports');
      await mkdir(directory);
      await writeFile(join(directory, '1.json'), JSON.stringify(shard));
      await writeFile(join(directory, '2.json'), JSON.stringify(second));
      const merged = await run(['--merge-shards', directory, '--shard-count', '2']);
      expect(merged).toMatchObject({ revision: { base, head }, skipped: true });
      expect(merged.shard).toBeUndefined();
    });
  });

  it('--ast-only grades a committed TSX test with a generic arrow and opens no lanes', async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src/view.tsx'), 'export const View = () => <p>a</p>;\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      await writeFile(join(dir, 'src/view.tsx'), 'export const View = <T,>(p: { v: T }) => <p>{String(p.v)}</p>;\n');
      await writeFile(join(dir, 'src/view.test.tsx'), [
        "import { it, expect } from 'vitest';",
        "import { View } from './view';",
        'const id = <T,>(value: T): T => value;',
        "it('renders', () => { expect(id(<View v={1} />).props.v).toBe(1); });",
        '',
      ].join('\n'));
      git(dir, 'add', '.');
      git(dir, 'commit', '-qm', 'head');
      let output = '';
      const code = await runCli({
        cwd: dir,
        argv: ['--json', '--ast-only'],
        env: { FIREGUARD_BASE_REF: base },
        stdout: (text) => { output += text; },
        stderr: () => undefined,
      });
      const report = JSON.parse(output) as FireguardReport;
      expect(code).toBe(0);
      expect(report).toMatchObject({
        astOnly: true,
        scope: { gradedTestFiles: ['src/view.test.tsx'], changedModules: ['src/view.tsx'] },
        gates: { ast: { pass: true, assertionCount: 1 } },
      });
      expect(report.execution).toBeUndefined();
      expect(report.gates.flake).toBeUndefined();
    });
  });

  it('refuses --ast-only with sharding or PR comments', async () => {
    let error = '';
    const code = await runCli({
      cwd: process.cwd(),
      argv: ['--ast-only', '--comment-pr'],
      stdout: () => undefined,
      stderr: (text) => { error += text; },
    });
    expect(code).toBe(2);
    expect(error).toContain('--ast-only cannot shard, merge or post PR comments');
  });
});
