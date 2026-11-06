import { describe, it, expect, vi } from 'vitest';
import { runFlakeGate } from '../src/gates/flakeGate.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { FireguardConfig, RunOnceResult, TestRunner } from '../src/types.js';
import { deferred, settleMicrotasks, type Deferred } from './support.js';

function withRuns(agenticFlakinessRuns: number): FireguardConfig {
  return {
    ...DEFAULT_CONFIG,
    thresholds: { ...DEFAULT_CONFIG.thresholds, agenticFlakinessRuns },
  };
}

describe('runFlakeGate', () => {
  it('passes when every isolated run succeeds for new tests', async () => {
    const runOnce = vi.fn(async () => ({ ok: true }));
    const gate = await runFlakeGate({
      config: withRuns(5),
      files: ['src/new.test.ts'],
      runners: [runOnce],
    });
    expect(gate.pass).toBe(true);
    expect(gate.runs).toBe(5);
    expect(gate.configuredRuns).toBe(5);
    expect(gate.failFast).toBe(true);
    expect(gate.failures).toBe(0);
    expect(runOnce).toHaveBeenCalledTimes(5);
    expect(runOnce).toHaveBeenCalledWith(['src/new.test.ts']);
  });

  it('fails on first flake and records the failing run', async () => {
    let n = 0;
    const runOnce = vi.fn(async () => {
      n += 1;
      if (n === 3) return { ok: false, error: 'boom' };
      return { ok: true };
    });
    const gate = await runFlakeGate({
      config: withRuns(5),
      files: ['src/flaky.test.ts'],
      runners: [runOnce],
    });
    expect(gate.pass).toBe(false);
    expect(gate.failures).toBe(1);
    expect(gate.configuredRuns).toBe(5);
    expect(gate.runs).toBe(3);
    expect(gate.flakeRate).toBe(1 / 5);
    expect(gate.failedRuns[0]).toEqual({ run: 3, error: 'boom' });
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('skips with pass when there are no new test files', async () => {
    const runOnce = vi.fn(async () => ({ ok: true }));
    const gate = await runFlakeGate({
      config: DEFAULT_CONFIG,
      files: [],
      runners: [runOnce],
    });
    expect(gate.pass).toBe(true);
    expect(gate.runs).toBe(0);
    expect(runOnce).not.toHaveBeenCalled();
  });
});

/** A runner whose runs the test settles by hand, in order. */
function heldRunner() {
  const held: Array<Deferred<RunOnceResult>> = [];
  const run: TestRunner = () => {
    const next = deferred<RunOnceResult>();
    held.push(next);
    return next.promise;
  };
  return { held, run };
}

describe('runFlakeGate over several lanes', () => {
  it('runs one run per lane at a time and gives the next run to whichever lane is free', async () => {
    const a = heldRunner();
    const b = heldRunner();
    const gate = runFlakeGate({ config: withRuns(3), files: ['src/x.test.ts'], runners: [a.run, b.run] });
    await settleMicrotasks();
    expect([a.held.length, b.held.length]).toEqual([1, 1]);
    b.held[0]!.resolve({ ok: true });
    await settleMicrotasks();
    expect([a.held.length, b.held.length]).toEqual([1, 2]);
    a.held[0]!.resolve({ ok: true });
    b.held[1]!.resolve({ ok: true });
    const result = await gate;
    expect([result.pass, result.runs, result.configuredRuns]).toEqual([true, 3, 3]);
  });

  it('starts no run after a failure, lets runs under way finish, and reports every failure', async () => {
    const a = heldRunner();
    const b = heldRunner();
    const gate = runFlakeGate({ config: withRuns(10), files: ['src/x.test.ts'], runners: [a.run, b.run] });
    await settleMicrotasks();
    b.held[0]!.resolve({ ok: false, error: 'second lane' });
    await settleMicrotasks();
    a.held[0]!.resolve({ ok: false, error: 'first lane' });
    const result = await gate;
    expect([a.held.length, b.held.length]).toEqual([1, 1]);
    expect(result.pass).toBe(false);
    expect(result.runs).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.flakeRate).toBe(2 / 10);
    expect(result.failedRuns).toEqual([
      { run: 1, error: 'first lane' },
      { run: 2, error: 'second lane' },
    ]);
  });
});
