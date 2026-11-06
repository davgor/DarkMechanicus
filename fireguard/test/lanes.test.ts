import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createLane, vitestArgs, type Lane } from '../src/lanes.js';
import { withTempDir } from './support.js';

describe('vitestArgs', () => {
  it.each([
    ['npx vitest run', []],
    ['node node_modules/vitest/vitest.mjs run', []],
    ['node_modules\\.bin\\vitest.cmd run', []],
    ['vitest run --config vitest.unit.ts --project a', ['--config', 'vitest.unit.ts', '--project', 'a']],
    ['vitest', []],
    ['vitest --config x', ['--config', 'x']],
  ])('reads the vitest run options of %s', (command, args) => {
    expect(vitestArgs(command)).toEqual(args);
  });

  it.each(['npm test', 'jest --ci', 'vitest bench', 'vitest related src/a.ts', 'my-vitest-wrapper run'])(
    'is undefined for %s, which is not a plain vitest test run',
    (command) => {
      expect(vitestArgs(command)).toBeUndefined();
    }
  );
});

describe('command lanes', () => {
  it('start testCommand per run, adding --passWithNoTests to mutant runs only', async () => {
    // `--` makes node hand the flags to the script instead of parsing them as its own options.
    const testCommand = "node -e process.exit(process.argv.includes('--passWithNoTests')?0:9) --";
    const lane = createLane({ dir: process.cwd(), config: { ...DEFAULT_CONFIG, testCommand } });
    expect(await lane.run(['x.spec.ts'], { mutant: true })).toEqual({ ok: true });
    expect((await lane.run(['x.spec.ts'])).ok).toBe(false);
    expect(await lane.run([])).toEqual({ ok: true });
    lane.changed('src/x.ts');
    await lane.close();
  });
});

const NODE_MODULES = dirname(dirname(createRequire(import.meta.url).resolve('vitest/package.json')));
const ORIGINAL = 'export const inc = (n: number): number => n + 1;\n';
const TEST = [
  "import { expect, it } from 'vitest';",
  "import { inc } from './m';",
  "it('adds one', () => {",
  '  expect(inc(1)).toBe(2);',
  '});',
  '',
].join('\n');
/** Leaves unhandled rejections whose values are not errors, created without a prototype. */
const ODD = [
  "import { it } from 'vitest';",
  "it('leaves odd rejections', async () => {",
  '  void Promise.reject(Object.create(null));',
  '  void Promise.reject(Object.assign(Object.create(null), { message: 7 }));',
  '  await new Promise((resolve) => setTimeout(resolve, 50));',
  '});',
  '',
].join('\n');
const HANG = "import { it } from 'vitest';\nit('hangs', () => {\n  for (;;) {}\n});\n";

/** A tiny vitest project using this repository's vitest. */
async function fixture(dir: string): Promise<string> {
  const root = join(dir, 'fixture');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "type": "module", "private": true }\n');
  await writeFile(join(root, 'src/m.ts'), ORIGINAL);
  await writeFile(join(root, 'src/m.test.ts'), TEST);
  await writeFile(join(root, 'src/hang.test.ts'), HANG);
  await writeFile(join(root, 'src/odd.test.ts'), ODD);
  await writeFile(join(root, 'src/notATest.ts'), 'export {};\n');
  // A junction needs no privileges on Windows; elsewhere it is a plain symlink.
  await symlink(NODE_MODULES, join(root, 'node_modules'), 'junction');
  return root;
}

async function withLane(
  testTimeoutMs: number,
  run: (lane: Lane, root: string) => Promise<void>
): Promise<void> {
  await withTempDir(async (dir) => {
    const root = await fixture(dir);
    const config = { ...DEFAULT_CONFIG, testCommand: 'npx vitest run', testTimeoutMs };
    const lane = createLane({ dir: root, config, maxWorkers: 1 });
    try {
      await run(lane, root);
    } finally {
      await lane.close();
    }
  });
}

describe('warm vitest lanes', () => {
  it('pass and fail runs in one long-lived vitest that sees rewritten sources', async () => {
    await withLane(60_000, async (lane, root) => {
      expect(await lane.run(['src/m.test.ts'])).toEqual({ ok: true });
      await writeFile(join(root, 'src/m.ts'), ORIGINAL.replace('n + 1', 'n - 1'));
      lane.changed('src/m.ts');
      const killed = await lane.run(['src/m.test.ts'], { mutant: true });
      expect(killed.ok).toBe(false);
      expect(killed.error).toContain('FAIL src/m.test.ts > adds one');
      await writeFile(join(root, 'src/m.ts'), ORIGINAL);
      lane.changed('src/m.ts');
      expect(await lane.run(['src/m.test.ts'])).toEqual({ ok: true });
    });
  }, 120_000);

  it('pass a mutant batch that collects no test file, and fail such a flake run', async () => {
    await withLane(60_000, async (lane) => {
      expect(await lane.run(['src/notATest.ts'], { mutant: true })).toEqual({ ok: true });
      const flake = await lane.run(['src/notATest.ts']);
      expect(flake.ok).toBe(false);
      expect(flake.error).toContain('No test files found');
    });
  }, 120_000);

  it('fail a run on unhandled errors, however odd the error value', async () => {
    await withLane(60_000, async (lane) => {
      const odd = await lane.run(['src/odd.test.ts']);
      expect(odd.ok).toBe(false);
      expect(odd.error).toContain('Unhandled error: ');
    });
  }, 120_000);

  it('fail a run that exceeds the timeout and start a fresh vitest for the next run', async () => {
    await withLane(8_000, async (lane) => {
      expect(await lane.run(['src/m.test.ts'])).toEqual({ ok: true });
      const hung = await lane.run(['src/hang.test.ts']);
      expect(hung).toEqual({ ok: false, error: 'fireguard: test run timed out after 8000ms' });
      expect(await lane.run(['src/m.test.ts'])).toEqual({ ok: true });
    });
  }, 120_000);

  it('throw when vitest cannot start in the workspace', async () => {
    await withTempDir(async (dir) => {
      const lane = createLane({ dir, config: { ...DEFAULT_CONFIG, testCommand: 'npx vitest run' } });
      await expect(lane.run(['src/m.test.ts'])).rejects.toThrow(/vitest could not start/);
      await lane.close();
    });
  }, 60_000);
});
