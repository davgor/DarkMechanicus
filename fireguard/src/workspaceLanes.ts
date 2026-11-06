import { availableParallelism } from 'node:os';
import { createLane, vitestArgs, type Lane } from './lanes.js';
import {
  createMutationApplier,
  readWorkspaceFile,
  readWorkspaceFileSync,
  workspaceFileExists,
} from './processAdapters.js';
import { snapshotCommittedTree, type Snapshots } from './snapshots.js';
import type { Execution, FireguardConfig, Lanes, WorkspaceSource } from './types.js';

function workspaceSource(dir: string): WorkspaceSource {
  return {
    readFile: (path) => readWorkspaceFile(dir, path),
    fileExists: (path) => workspaceFileExists(dir, path),
    readFileSync: (path) => readWorkspaceFileSync(dir, path),
  };
}

async function trySnapshots(
  snapshot: (count: number) => Promise<Snapshots>,
  count: number
): Promise<{ snapshots?: Snapshots; fallbackReason?: string }> {
  try {
    return { snapshots: await snapshot(count) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { fallbackReason: `could not snapshot the committed tree: ${message}` };
  }
}

/**
 * Together the lanes run test workers on about two thirds of the CPUs. The rest is for each
 * lane's vitest, the processes tests start, and the OS (antivirus scans every file they touch):
 * at one worker per CPU, a CPU-heavy test ran 8 times slower than alone and came close to its
 * timeout, while two thirds ran as many runs per minute with it at half that.
 */
function workersPerLane(lanes: number, cpus: number): number | undefined {
  return lanes > 1 ? Math.max(1, Math.floor((cpus * 2) / (3 * lanes))) : undefined;
}

/**
 * Opens the lanes the flake and mutation gates run in: one per `concurrency`, each in its own
 * snapshot of the committed tree, each vitest run capped to the lane's share of the CPUs. A
 * lane runs one flake run or one mutant at a time; a mutant is written into the lane's
 * snapshot only. If the snapshots cannot be made, there is one lane, the working tree, and
 * mutants are written into it in turn and restored; the execution says why.
 */
export async function openLanes(options: {
  cwd: string;
  config: FireguardConfig;
  /** Test seam: makes the snapshots. */
  snapshot?: (count: number) => Promise<Snapshots>;
  /** Test seam: the lane for one workspace, with its vitest worker cap. */
  laneFor?: (dir: string, maxWorkers: number | undefined) => Lane;
  /** Test seam: CPUs to share between the lanes. */
  cpus?: number;
}): Promise<Lanes> {
  const { cwd, config } = options;
  const snapshot = options.snapshot ?? ((count) => snapshotCommittedTree({ cwd, count }));
  const laneFor =
    options.laneFor ?? ((dir, maxWorkers) => createLane({ dir, config, maxWorkers }));

  const { snapshots, fallbackReason } = await trySnapshots(snapshot, config.concurrency);
  const dirs = snapshots?.dirs ?? [cwd];
  const maxWorkers = workersPerLane(dirs.length, options.cpus ?? availableParallelism());
  const lanes = dirs.map((dir) => laneFor(dir, maxWorkers));

  const execution: Execution = {
    lanes: lanes.length,
    workspace: snapshots ? 'committed' : 'working-tree',
    runner: vitestArgs(config.testCommand) ? 'warm' : 'command',
    ...(fallbackReason ? { fallbackReason } : {}),
  };
  return {
    runners: lanes.map((lane) => (files) => lane.run(files)),
    appliers: lanes.map((lane) =>
      createMutationApplier({
        cwd: lane.dir,
        runOnce: (files) => lane.run(files, { mutant: true }),
        changed: (file) => lane.changed(file),
      })
    ),
    execution,
    source: workspaceSource(dirs[0]!),
    close: async () => {
      try {
        await Promise.all(lanes.map((lane) => lane.close()));
      } finally {
        await snapshots?.dispose();
      }
    },
  };
}
