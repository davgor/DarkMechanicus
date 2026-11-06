import { runOnLanes } from '../lanePool.js';
import type { FireguardConfig, FlakeGateResult, TestRunner } from '../types.js';

interface FlakeOptions {
  config: FireguardConfig;
  files: string[];
  /** One runner per lane; each runs one run at a time. */
  runners: TestRunner[];
  /**
   * When true (default), start no run after the first failure; runs already under way finish.
   * Metrics still report configuredRuns.
   */
  failFast?: boolean;
}

/** Runs the graded files `configuredRuns` times over the lanes; counts and failures, run order. */
async function runAll(options: FlakeOptions, failFast: boolean, configuredRuns: number) {
  const failedRuns: FlakeGateResult['failedRuns'] = [];
  let executed = 0;
  await runOnLanes(
    configuredRuns,
    options.runners,
    async (index, runOnce) => {
      const result = await runOnce(options.files);
      executed += 1;
      if (result.ok) return;
      failedRuns.push({ run: index + 1, error: result.error ?? 'test run failed' });
    },
    () => failFast && failedRuns.length > 0
  );
  failedRuns.sort((a, b) => a.run - b.run);
  return { executed, failedRuns };
}

/**
 * Runs the graded tests `agenticFlakinessRuns` times. Each run is a whole, isolated test run of
 * every graded file; with several runners (one per lane, each in its own workspace) runs go to
 * whichever lane is free, so several run at once.
 */
export async function runFlakeGate(options: FlakeOptions): Promise<FlakeGateResult> {
  const files = options.files;
  const failFast = options.failFast ?? true;
  const configuredRuns = options.config.thresholds.agenticFlakinessRuns;
  const { executed, failedRuns } =
    files.length === 0
      ? { executed: 0, failedRuns: [] }
      : await runAll(options, failFast, configuredRuns);

  const failures = failedRuns.length;
  // Honest rate: failures against the configured budget, not only executed runs.
  const flakeRate = failures === 0 ? 0 : failures / configuredRuns;
  return {
    name: 'flake',
    pass: failures === 0 && flakeRate <= options.config.thresholds.maxFlakeRate,
    runs: executed,
    configuredRuns,
    failures,
    flakeRate,
    files,
    failedRuns,
    failFast,
  };
}
