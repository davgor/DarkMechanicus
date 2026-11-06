import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNameStatus } from './gitScope.js';
import type {
  ApplyAndTest,
  DiffEntry,
  FireguardConfig,
  RunOnceResult,
  TestRunner,
} from './types.js';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Exit code reported for a run that fireguard killed after `timeoutMs` (the `timeout(1)` convention). */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Kills a spawned command together with everything it started (vitest workers, grandchildren).
 * Off Windows the command must have been spawned `detached`, so it leads its own process group.
 */
export function killTree(pid: number | undefined): void {
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
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: options.env ?? process.env,
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
    // Decoded as a stream, so a character split across chunks is not garbled (file contents).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
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

/**
 * `git diff <args> base...HEAD`: the committed changes since the merge base. Shallow clones
 * without a merge base fall back to `base HEAD`. Either way only committed changes count.
 */
async function gitDiff(options: { cwd: string; baseRef: string }, args: string[]): Promise<string> {
  // Unquoted non-ASCII paths, no external diff tool or colour, whatever the user's git config.
  const base = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-color'];
  const run = (range: string[]): Promise<CommandResult> =>
    runCommand('git', [...base, ...args, ...range], { cwd: options.cwd });
  const result = await run([`${options.baseRef}...HEAD`]);
  if (result.code === 0) return result.stdout;
  const fallback = await run([options.baseRef, 'HEAD']);
  if (fallback.code !== 0) {
    throw new Error(`git diff failed: ${result.stderr || fallback.stderr || 'unknown git error'}`);
  }
  return fallback.stdout;
}

export async function getGitDiffEntries(options: {
  cwd: string;
  baseRef: string;
}): Promise<DiffEntry[]> {
  return parseNameStatus(await gitDiff(options, ['--name-status']));
}

/**
 * Lines each file gained or changed (new side, 1-based), from `git diff -U0` hunk headers.
 * Pure deletions add no line; a file the diff does not mention is left out.
 */
export function parseChangedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trimEnd();
      // `+++ /dev/null` is a deleted file; `+++ b/x` names the new path.
      lines = path.startsWith('b/') ? new Set() : undefined;
      if (lines) changed.set(path.slice(2), lines);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !lines) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n += 1) lines.add(n);
  }
  return changed;
}

/** Changed lines of `paths` in the committed diff against `baseRef` (see `parseChangedLines`). */
export async function getChangedLines(options: {
  cwd: string;
  baseRef: string;
  paths: string[];
}): Promise<Map<string, Set<number>>> {
  if (options.paths.length === 0) return new Map();
  const diff = await gitDiff(options, ['-U0', '--src-prefix=a/', '--dst-prefix=b/']);
  const wanted = new Set(options.paths);
  const changed = parseChangedLines(diff);
  for (const path of changed.keys()) if (!wanted.has(path)) changed.delete(path);
  return changed;
}

/** A file as HEAD has it (`git show HEAD:path`). */
export async function readCommittedFile(cwd: string, path: string): Promise<string> {
  const result = await runCommand('git', ['show', `HEAD:${path}`], { cwd });
  if (result.code !== 0) {
    throw new Error(`git show HEAD:${path} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

export function createVitestRunner(options: {
  cwd: string;
  config: FireguardConfig;
  /** Caps the vitest workers of each run (VITEST_MAX_WORKERS), so parallel lanes share the CPUs. */
  maxWorkers?: number;
  /**
   * Runs that test a mutant, where any failure means "killed". They add `--passWithNoTests`, so
   * a batch vitest collects no files from (outside its `include`) passes instead of counting as
   * a kill, and `--bail=1`, so vitest stops at the first failing test instead of also waiting
   * out every other test the mutant hangs. Neither changes which mutants are killed.
   */
  mutantRun?: boolean;
}): (files: string[]) => Promise<RunOnceResult> {
  const env =
    options.maxWorkers === undefined
      ? process.env
      : { ...process.env, VITEST_MAX_WORKERS: String(options.maxWorkers) };
  const parts = options.config.testCommand.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? 'npx';
  const baseArgs = parts.slice(1);
  if (options.mutantRun) baseArgs.push('--passWithNoTests', '--bail=1');
  return async (files: string[]) => {
    if (files.length === 0) return { ok: true };
    const result = await runCommand(command, [...baseArgs, ...files], {
      cwd: options.cwd,
      timeoutMs: options.config.testTimeoutMs,
      env,
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
  runOnce: TestRunner;
  /**
   * Called after each write of `file` (the mutant, then the restored original), so a runner that
   * keeps modules loaded between runs reloads it.
   */
  changed?: (file: string) => void;
}): ApplyAndTest {
  installExitHook();
  const write = async (file: string, filePath: string, source: string): Promise<void> => {
    await writeFile(filePath, source, 'utf8');
    options.changed?.(file);
  };
  return async (input) => {
    const filePath = join(options.cwd, input.file);
    pendingRestores.set(filePath, input.originalSource);
    await write(input.file, filePath, input.mutatedSource);
    try {
      if (input.relatedTests.length === 0) {
        // No related graded tests — treat mutant as survived (cannot validate)
        return { ok: true };
      }
      return await options.runOnce(input.relatedTests);
    } finally {
      await write(input.file, filePath, input.originalSource);
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
