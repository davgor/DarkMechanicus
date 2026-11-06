import { describe, it, expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Lane } from '../src/lanes.js';
import type { Snapshots } from '../src/snapshots.js';
import type { FireguardConfig } from '../src/types.js';
import { openLanes } from '../src/workspaceLanes.js';
import { withTempDir } from './support.js';

const MODULE = 'src/m.ts';
const ORIGINAL = 'export const m = 1;\n';
const MUTANT = 'export const m = 2;\n';

const MUTANT_RUN = {
  file: MODULE,
  originalSource: ORIGINAL,
  mutatedSource: MUTANT,
  relatedTests: ['src/m.test.ts'],
};

interface Run {
  dir: string;
  files: string[];
  mutant: boolean;
  source: string;
}

/** Fake lanes that record each run, with what the module held at the time, and each change. */
function recordingLanes(fail = false) {
  const runs: Run[] = [];
  const created: Array<{ dir: string; workers: number | undefined }> = [];
  const changed: Array<{ dir: string; file: string }> = [];
  const closed: string[] = [];
  const laneFor = (dir: string, workers: number | undefined): Lane => {
    created.push({ dir, workers });
    return {
      dir,
      run: async (files, options) => {
        const source = await readFile(join(dir, MODULE), 'utf8');
        runs.push({ dir, files, mutant: Boolean(options?.mutant), source });
        return { ok: !fail };
      },
      changed: (file) => changed.push({ dir, file }),
      close: async () => {
        closed.push(dir);
      },
    };
  };
  return { runs, created, changed, closed, laneFor };
}

async function workspaceWithModule(dir: string, name: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, MODULE), ORIGINAL);
  return root;
}

/** Fake snapshots over real directories, so appliers write real files. */
function fakeSnapshots(dir: string) {
  const state = { disposed: 0, requested: [] as number[] };
  const snapshot = async (count: number): Promise<Snapshots> => {
    state.requested.push(count);
    const dirs: string[] = [];
    for (let i = 0; i < count; i += 1) dirs.push(await workspaceWithModule(dir, `lane-${i}`));
    return {
      dirs,
      dispose: async () => {
        state.disposed += 1;
      },
    };
  };
  return { state, snapshot };
}

function withConcurrency(concurrency: number, testCommand = 'npx vitest run'): FireguardConfig {
  return { ...DEFAULT_CONFIG, concurrency, testCommand };
}

describe('openLanes over snapshots', () => {
  it('opens one capped lane per snapshot for flake runs, mutants and source reads', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const lanes = recordingLanes();
      const { state, snapshot } = fakeSnapshots(dir);
      const opened = await openLanes({
        cwd,
        config: withConcurrency(3),
        snapshot,
        laneFor: lanes.laneFor,
        cpus: 12,
      });
      const dirs = [0, 1, 2].map((i) => join(dir, `lane-${i}`));
      expect(state.requested).toEqual([3]);
      // Two thirds of 12 CPUs over 3 lanes.
      expect(lanes.created).toEqual(dirs.map((laneDir) => ({ dir: laneDir, workers: 2 })));
      expect(opened.execution).toEqual({ lanes: 3, workspace: 'committed', runner: 'warm' });
      expect([opened.runners.length, opened.appliers.length]).toEqual([3, 3]);

      expect(await opened.runners[1]!(['src/a.test.ts'])).toEqual({ ok: true });
      expect(await opened.appliers[2]!(MUTANT_RUN)).toEqual({ ok: true });
      expect(lanes.runs).toEqual([
        { dir: dirs[1], files: ['src/a.test.ts'], mutant: false, source: ORIGINAL },
        { dir: dirs[2], files: ['src/m.test.ts'], mutant: true, source: MUTANT },
      ]);
      // The mutant and then the restored original were each reported to the lane.
      expect(lanes.changed).toEqual([
        { dir: dirs[2], file: MODULE },
        { dir: dirs[2], file: MODULE },
      ]);
      expect(await readFile(join(dirs[2]!, MODULE), 'utf8')).toBe(ORIGINAL);
      expect(await readFile(join(cwd, MODULE), 'utf8')).toBe(ORIGINAL);

      await writeFile(join(dirs[0]!, MODULE), 'export const fromSnapshot = 1;\n');
      expect(await opened.source.readFile(MODULE)).toBe('export const fromSnapshot = 1;\n');
      expect(opened.source.fileExists?.(MODULE)).toBe(true);
      expect(opened.source.readFileSync?.('src/none.ts')).toBeNull();

      expect(state.disposed).toBe(0);
      await opened.close();
      expect(lanes.closed).toEqual(dirs);
      expect(state.disposed).toBe(1);
    });
  });

  it('leaves the vitest worker count alone with a single lane', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const lanes = recordingLanes();
      const { snapshot } = fakeSnapshots(dir);
      await openLanes({ cwd, config: withConcurrency(1), snapshot, laneFor: lanes.laneFor });
      expect(lanes.created).toEqual([{ dir: join(dir, 'lane-0'), workers: undefined }]);
    });
  });

  it('starts testCommand per run when it is not a vitest command', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const { snapshot } = fakeSnapshots(dir);
      const opened = await openLanes({
        cwd,
        config: withConcurrency(2, 'npm test --'),
        snapshot,
        laneFor: recordingLanes().laneFor,
      });
      expect(opened.execution.runner).toBe('command');
    });
  });

  it('disposes the snapshots even when a lane fails to close', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const { state, snapshot } = fakeSnapshots(dir);
      const opened = await openLanes({
        cwd,
        config: withConcurrency(2),
        snapshot,
        laneFor: (laneDir) => ({
          dir: laneDir,
          run: async () => ({ ok: true }),
          changed: () => {},
          close: async () => {
            throw new Error('lane stuck');
          },
        }),
      });
      await expect(opened.close()).rejects.toThrow('lane stuck');
      expect(state.disposed).toBe(1);
    });
  });
});

describe('openLanes without snapshots', () => {
  it('runs one lane in the working tree, mutating and restoring it, and says why', async () => {
    await withTempDir(async (dir) => {
      const cwd = await workspaceWithModule(dir, 'repo');
      const lanes = recordingLanes(true);
      const opened = await openLanes({
        cwd,
        config: withConcurrency(4),
        snapshot: async () => {
          throw new Error('ENOSPC: no space left on device');
        },
        laneFor: lanes.laneFor,
      });
      expect(opened.execution).toEqual({
        lanes: 1,
        workspace: 'working-tree',
        runner: 'warm',
        fallbackReason: 'could not snapshot the committed tree: ENOSPC: no space left on device',
      });
      expect(lanes.created).toEqual([{ dir: cwd, workers: undefined }]);
      expect(await opened.appliers[0]!(MUTANT_RUN)).toEqual({ ok: false });
      expect(lanes.runs).toEqual([
        { dir: cwd, files: ['src/m.test.ts'], mutant: true, source: MUTANT },
      ]);
      expect(await readFile(join(cwd, MODULE), 'utf8')).toBe(ORIGINAL);
      await opened.close();
      expect(lanes.closed).toEqual([cwd]);
    });
  });
});
