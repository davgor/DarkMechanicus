import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { createVitestRunner, runCommand } from '../src/processAdapters.js';

/** A child that starts a busy grandchild, reports its pid synchronously, then busy-loops itself. */
const HANG_WITH_GRANDCHILD = [
  "const c = require('child_process').spawn(process.execPath, ['-e', 'while(true){}'], { stdio: 'ignore' });",
  "require('fs').writeSync(1, String(c.pid) + '\\n');",
  'while (true) {}',
].join(' ');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, attempts = 100): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

describe('runCommand timeout', () => {
  it('kills a hung command and everything it started, reporting a timeout', async () => {
    const result = await runCommand(process.execPath, ['-e', HANG_WITH_GRANDCHILD], {
      cwd: process.cwd(),
      timeoutMs: 1500,
    });
    const grandchild = Number.parseInt(result.stdout.trim(), 10);
    expect([result.timedOut, result.code]).toEqual([true, 124]);
    expect(result.stderr).toContain('fireguard: test run timed out after 1500ms');
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(await waitUntilGone(grandchild)).toBe(true);
  });

  it('leaves commands that finish in time alone', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.exit(3)'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect([result.timedOut, result.code]).toEqual([false, 3]);
  });
});

describe('createVitestRunner timeout', () => {
  it('reports a run that exceeds testTimeoutMs as failed so a hanging mutant counts as killed', async () => {
    const run = createVitestRunner({
      cwd: process.cwd(),
      config: { ...DEFAULT_CONFIG, testCommand: `${process.execPath} -e while(true){}`, testTimeoutMs: 800 },
    });
    const result = await run(['some.test.ts']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out after 800ms');
  });
});

describe('testTimeoutMs config', () => {
  it('defaults to five minutes and accepts file and env overrides', () => {
    expect(DEFAULT_CONFIG.testTimeoutMs).toBe(300_000);
    const fromFile = loadConfig({
      cwd: process.cwd(),
      readFile: () => JSON.stringify({ testTimeoutMs: 60_000 }),
      env: {},
    });
    expect(fromFile.testTimeoutMs).toBe(60_000);
    const fromEnv = loadConfig({
      cwd: process.cwd(),
      readFile: () => JSON.stringify({ testTimeoutMs: 60_000 }),
      env: { FIREGUARD_TEST_TIMEOUT_MS: '90000' },
    });
    expect(fromEnv.testTimeoutMs).toBe(90_000);
  });
});
