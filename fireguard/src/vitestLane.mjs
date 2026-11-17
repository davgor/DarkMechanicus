// @ts-check
/**
 * A fireguard lane: one long-lived Vitest for the workspace in the current directory. The parent
 * (`lanes.ts`) sends test runs over IPC. Keeping Vitest alive saves its start-up and Vite's
 * module transforms on every run; each run still gets fresh test workers, as `vitest run` does,
 * so runs stay isolated from each other.
 *
 * Plain JavaScript run by plain `node`, so the test workers it starts never inherit a loader.
 *
 * argv[2]: JSON array of `vitest run` options from `testCommand`.
 * Parent -> lane: { type: 'run', id, files, passWithNoTests, changed } | { type: 'close' }
 * Lane -> parent: { type: 'ready' } | { type: 'fatal', error }
 *               | { type: 'result', id, ok, error? } | { type: 'error', id, error }
 */
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_ERROR = 2000;

/** @param {unknown} message */
function send(message) {
  process.send?.(message);
}

/**
 * A message for anything thrown or reported as an error, never throwing itself: Vitest's
 * serialized errors can be objects without a prototype, which `String()` rejects.
 * @param {unknown} error
 */
function messageOf(error) {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    if (typeof error.message === 'string') return error.message;
  }
  try {
    return String(error);
  } catch {
    try {
      return JSON.stringify(error) ?? 'unknown error';
    } catch {
      return 'unknown error';
    }
  }
}

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? (error.stack ?? error.message) : messageOf(error);
}

/** Vitest resolved from the workspace, as `node_modules/.bin/vitest` there would be. */
async function loadVitest() {
  const require = createRequire(join(process.cwd(), 'package.json'));
  return import(pathToFileURL(require.resolve('vitest/node')).href);
}

/**
 * The failing tests of the run under way (`FAIL file > test: message`), or undefined between
 * runs.
 * @type {string[] | undefined}
 */
let runFailures;

/**
 * The lane's own bail: it records each failing test of the run under way and cancels the run at
 * the first. Vitest's `bail` has every worker that fails a test cancel the run, and a second
 * cancel while the first is settling force-stops the workers, so results they had not sent yet
 * (the failure that decided the run among them) are lost: a killed mutant read as passing. One
 * cancel lets the workers under way finish and report.
 */
const bailReporter = {
  onTestCaseResult(/** @type {any} */ testCase) {
    const result = testCase.result();
    if (runFailures === undefined || result.state !== 'failed') return;
    const error = result.errors?.[0];
    const message = error === undefined ? 'failed' : messageOf(error);
    runFailures.push(`FAIL ${testCase.module.relativeModuleId} > ${testCase.fullName}: ${message}`);
    // Not awaited: the cancel waits for the run, which waits for this report. A cancel that fails
    // only lets the run go on; the failure recorded above already decides it.
    if (runFailures.length === 1) vitest.cancelCurrentRun('test-failure').catch(() => {});
  },
};

/** @param {string[]} args */
async function openVitest(args) {
  // What `vitest run` sets before it creates Vitest.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  const { createVitest, parseCLI } = await loadVitest();
  const { options } = parseCLI(['vitest', 'run', ...args]);
  // A run ends at its first failing test, which already decides it (a failed flake run, a killed
  // mutant); the bail reporter ends it, so Vitest's own bail is off.
  return createVitest('test', { ...options, watch: false, reporters: [bailReporter], bail: 0 });
}

/**
 * @param {any[]} modules failed test modules
 * @param {string[]} tests failing tests
 * @param {unknown[]} unhandled
 */
function describeFailure(modules, tests, unhandled) {
  const lines = [];
  for (const mod of modules) {
    for (const error of mod.errors()) lines.push(`FAIL ${mod.relativeModuleId}: ${messageOf(error)}`);
  }
  lines.push(...tests);
  for (const error of unhandled) lines.push(`Unhandled error: ${messageOf(error)}`);
  return lines.join('\n').slice(-MAX_ERROR);
}

/**
 * The ids Vite may know a workspace file by: its path from this directory and its real path
 * (which also expands Windows 8.3 short names such as `RUNNER~1`), with forward slashes.
 * @param {string} file repo-relative
 */
function moduleIds(file) {
  const path = resolve(file);
  const ids = new Set([path]);
  try {
    ids.add(realpathSync.native(path));
  } catch {
    // Gone from disk: nothing more to name it by.
  }
  return [...ids].map((id) => id.split('\\').join('/'));
}

/**
 * @param {any} vitest
 * @param {{ files: string[], passWithNoTests: boolean, changed: string[] }} request
 */
async function run(vitest, request) {
  // Source files rewritten since the last run (a mutant, its restore): reload them.
  for (const file of request.changed) {
    for (const id of moduleIds(file)) {
      vitest.invalidateFile(id);
      vitest.watcher.invalidates.add(id);
    }
  }
  const specs = await vitest.getRelevantTestSpecifications(request.files);
  if (specs.length === 0) {
    if (request.passWithNoTests) return { ok: true };
    return { ok: false, error: `No test files found: ${request.files.join(' ')}` };
  }
  const ids = new Set(specs.map((/** @type {any} */ spec) => spec.moduleId));
  /** @type {string[]} */
  const failures = [];
  runFailures = failures;
  const result = await vitest.runTestSpecifications(specs).finally(() => {
    runFailures = undefined;
  });
  const failed = result.testModules.filter(
    (/** @type {any} */ mod) => ids.has(mod.moduleId) && !mod.ok()
  );
  if (failed.length > 0 || failures.length > 0 || result.unhandledErrors.length > 0) {
    return { ok: false, error: describeFailure(failed, failures, result.unhandledErrors) };
  }
  return { ok: true };
}

/** @type {any} */
let vitest;
try {
  vitest = await openVitest(JSON.parse(process.argv[2] ?? '[]'));
} catch (error) {
  send({ type: 'fatal', error: errorText(error).slice(-MAX_ERROR) });
  process.exit(1);
}

let queue = Promise.resolve();
process.on('message', (/** @type {any} */ message) => {
  queue = queue.then(async () => {
    if (message.type === 'close') {
      await vitest.close();
      process.exit(0);
    }
    try {
      send({ type: 'result', id: message.id, ...(await run(vitest, message)) });
    } catch (error) {
      send({ type: 'error', id: message.id, error: errorText(error).slice(-MAX_ERROR) });
    }
  });
});
// The parent is gone: nothing will read results, so stop (Vitest's workers follow).
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
