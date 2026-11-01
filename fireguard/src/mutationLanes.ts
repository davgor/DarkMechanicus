import { availableParallelism } from 'node:os';
import { createMutationApplier, createVitestRunner } from './processAdapters.js';
import type { FireguardConfig, MutationLanes, TestRunner } from './types.js';
import { copyWorkspace, type WorkspaceCopies } from './workspaceCopies.js';

/**
 * Opens the lanes the mutation gate spreads mutants over. With `concurrency` 1 there is one
 * lane, the working tree itself. Above 1 there is one lane per temporary workspace copy, each
 * vitest run capped to its share of the CPUs. The copies are used only once the graded tests
 * pass in one of them (the flake gate has just shown they pass in the working tree); a copy
 * that cannot reproduce the working tree would otherwise "kill" every mutant. If copying
 * fails or that baseline run fails, mutants run in the working tree one at a time, as at
 * concurrency 1, and the report says why.
 */
export async function openMutationLanes(options: {
  cwd: string;
  config: FireguardConfig;
  gradedTests: string[];
  /** Test seam: makes the workspace copies. */
  copy?: (count: number) => Promise<WorkspaceCopies>;
  /** Test seam: the test runner for one workspace, with its vitest worker cap. */
  runnerFor?: (dir: string, maxWorkers: number | undefined) => TestRunner;
  /** Test seam: CPUs to share between the lanes. */
  cpus?: number;
}): Promise<MutationLanes> {
  const { cwd, config } = options;
  // Mutant runs: a batch vitest collects no tests from passes, and the first failure ends the run.
  const runnerFor =
    options.runnerFor ??
    ((dir, maxWorkers) => createVitestRunner({ cwd: dir, config, maxWorkers, mutantRun: true }));
  const inPlace = (fallbackReason?: string): MutationLanes => ({
    appliers: [createMutationApplier({ cwd, runOnce: runnerFor(cwd, undefined) })],
    execution: fallbackReason
      ? { lanes: 1, workspace: 'in-place', fallbackReason }
      : { lanes: 1, workspace: 'in-place' },
    close: async () => {},
  });

  const count = config.concurrency;
  if (count <= 1) return inPlace();

  const copy = options.copy ?? ((copies) => copyWorkspace({ cwd, count: copies }));
  let copies: WorkspaceCopies;
  try {
    copies = await copy(count);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return inPlace(`could not copy the workspace: ${message}`);
  }

  // The baseline runs alone, so it keeps vitest's default worker count.
  const baseline = await runnerFor(copies.dirs[0]!, undefined)(options.gradedTests);
  if (!baseline.ok) {
    await copies.dispose();
    const reason = baseline.error ?? 'test run failed';
    return inPlace(`graded tests failed in a workspace copy: ${reason}`);
  }
  // Together the lanes use about as many vitest workers as one default run (CPUs - 1).
  const cpus = options.cpus ?? availableParallelism();
  const maxWorkers = Math.max(1, Math.ceil((cpus - 1) / count));
  return {
    appliers: copies.dirs.map((dir) =>
      createMutationApplier({ cwd: dir, runOnce: runnerFor(dir, maxWorkers) })
    ),
    execution: { lanes: copies.dirs.length, workspace: 'copies' },
    close: copies.dispose,
  };
}
