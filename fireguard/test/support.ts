import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplyAndTest, Lanes, TestRunner, WorkspaceSource } from '../src/types.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise the test settles by hand (the ES2022 lib has no `Promise.withResolvers`). */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves once every queued microtask has run (one macrotask turn, not a wall-clock wait). */
export function settleMicrotasks(): Promise<void> {
  const done = deferred();
  setImmediate(() => done.resolve());
  return done.promise;
}

/**
 * One lane over in-memory sources: flake runs go to `runOnce` (passing by default), mutants to
 * `applyAndTest`. Without `source`, reads return '' and there are no import-graph probes.
 */
export function fakeLanes(
  applyAndTest: ApplyAndTest,
  options: { runOnce?: TestRunner; source?: WorkspaceSource; close?: () => Promise<void> } = {}
): Lanes {
  return {
    runners: [options.runOnce ?? (async () => ({ ok: true }))],
    appliers: [applyAndTest],
    execution: { lanes: 1, workspace: 'committed', runner: 'warm' },
    source: options.source ?? { readFile: async () => '' },
    close: options.close ?? (async () => {}),
  };
}

/** Workspace source over a fixed set of files, with import-graph probes. */
export function memorySource(files: Record<string, string>): WorkspaceSource {
  return {
    readFile: async (path) => files[path] ?? '',
    fileExists: (path) => Object.hasOwn(files, path),
    readFileSync: (path) => files[path] ?? null,
  };
}

/** Runs `run` in a fresh temporary directory, removed afterwards. */
export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fireguard-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs git in `cwd` with a fixed identity; returns its trimmed output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=fg', '-c', 'user.email=fg@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** A git repository in `dir` whose checkouts keep LF line endings whatever the global config. */
export function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'core.autocrlf', 'false');
}
