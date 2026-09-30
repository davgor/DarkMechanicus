import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNameStatus } from './gitScope.js';
import type { DiffEntry, FireguardConfig, RunOnceResult } from './types.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Exit code reported for a run that fireguard killed after `timeoutMs` (the `timeout(1)` convention). */
const TIMEOUT_EXIT_CODE = 124;

/** Kills a spawned command together with everything it started (vitest workers, grandchildren). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // The child was spawned detached, so it leads its own process group: `-pid` signals all of it.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: process.env,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
          }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const note = timedOut ? `\nfireguard: test run timed out after ${options.timeoutMs}ms` : '';
      resolvePromise({
        code: timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1),
        stdout,
        stderr: `${stderr}${note}`,
        timedOut,
      });
    });
  });
}

export async function getGitDiffEntries(options: {
  cwd: string;
  baseRef: string;
}): Promise<DiffEntry[]> {
  const range = `${options.baseRef}...HEAD`;
  const result = await runCommand('git', ['diff', '--name-status', range], { cwd: options.cwd });
  if (result.code !== 0) {
    // Fallback for shallow clones / missing merge-base: diff against baseRef
    const fallback = await runCommand('git', ['diff', '--name-status', options.baseRef], {
      cwd: options.cwd,
    });
    if (fallback.code !== 0) {
      throw new Error(
        `git diff failed: ${result.stderr || fallback.stderr || 'unknown git error'}`
      );
    }
    return parseNameStatus(fallback.stdout);
  }
  return parseNameStatus(result.stdout);
}

export function createVitestRunner(options: {
  cwd: string;
  config: FireguardConfig;
}): (files: string[]) => Promise<RunOnceResult> {
  return async (files: string[]) => {
    if (files.length === 0) return { ok: true };
    const parts = options.config.testCommand.split(/\s+/).filter(Boolean);
    const command = parts[0] ?? 'npx';
    const baseArgs = parts.slice(1);
    const result = await runCommand(command, [...baseArgs, ...files], {
      cwd: options.cwd,
      timeoutMs: options.config.testTimeoutMs,
    });
    if (result.code === 0) return { ok: true };
    const output = result.stderr || result.stdout || `exit ${result.code}`;
    // Keep the tail: vitest prints the summary (and fireguard its timeout note) last.
    return { ok: false, error: output.slice(-2000) };
  };
}

/** Pending in-place restores so process `exit` can put sources back. */
const pendingRestores = new Map<string, string>();
let exitHookInstalled = false;

function restoreAllPending(): void {
  for (const [filePath, original] of pendingRestores) {
    try {
      writeFileSync(filePath, original, 'utf8');
    } catch {
      // best-effort on process teardown
    }
  }
  pendingRestores.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', restoreAllPending);
}

export function createMutationApplier(options: {
  cwd: string;
  runOnce: (files: string[]) => Promise<RunOnceResult>;
}): (input: {
  file: string;
  originalSource: string;
  mutatedSource: string;
  relatedTests: string[];
}) => Promise<RunOnceResult> {
  installExitHook();
  return async (input) => {
    const filePath = join(options.cwd, input.file);
    pendingRestores.set(filePath, input.originalSource);
    await writeFile(filePath, input.mutatedSource, 'utf8');
    try {
      if (input.relatedTests.length === 0) {
        // No related graded tests — treat mutant as survived (cannot validate)
        return { ok: true };
      }
      return await options.runOnce(input.relatedTests);
    } finally {
      await writeFile(filePath, input.originalSource, 'utf8');
      pendingRestores.delete(filePath);
    }
  };
}

export async function readWorkspaceFile(cwd: string, path: string): Promise<string> {
  return readFile(join(cwd, path), 'utf8');
}

/** True for regular files only, so a directory never shadows `./x.ts` when resolving imports. */
export function workspaceFileExists(cwd: string, path: string): boolean {
  try {
    return statSync(join(cwd, path)).isFile();
  } catch {
    return false;
  }
}

/** Synchronous read for import-graph scans; null when the file is missing or unreadable. */
export function readWorkspaceFileSync(cwd: string, path: string): string | null {
  try {
    return readFileSync(join(cwd, path), 'utf8');
  } catch {
    return null;
  }
}
