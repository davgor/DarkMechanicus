import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createVitestRunner, killTree } from './processAdapters.js';
import type { FireguardConfig, RunOnceResult } from './types.js';

/** One workspace that runs tests, one run at a time. */
export interface Lane {
  readonly dir: string;
  /**
   * Runs test files once. A `mutant` run passes when vitest collects none of the files (so a
   * batch outside vitest's `include` does not count as a kill).
   */
  run: (files: string[], options?: { mutant?: boolean }) => Promise<RunOnceResult>;
  /** A repo-relative source file was rewritten on disk; the next run must not use a stale copy. */
  changed: (file: string) => void;
  close: () => Promise<void>;
}

const LANE_SCRIPT = fileURLToPath(new URL('./vitestLane.mjs', import.meta.url));
/** Recent lane output kept for error messages. */
const OUTPUT_TAIL = 4000;
/** How long a closing lane gets to stop Vitest before it is killed. */
const CLOSE_GRACE_MS = 10_000;
const VITEST_BIN = /(^|[\\/])vitest(\.[cm]?js|\.cmd)?$/;

/**
 * The `vitest run` options in `testCommand` (`npx vitest run --config x` -> `--config x`), or
 * undefined when the command does not run vitest itself or runs another vitest subcommand.
 */
export function vitestArgs(testCommand: string): string[] | undefined {
  const parts = testCommand.split(/\s+/).filter(Boolean);
  const at = parts.findIndex((part) => VITEST_BIN.test(part));
  if (at === -1) return undefined;
  const args = parts.slice(at + 1);
  if (args[0] === 'run') return args.slice(1);
  return args.length === 0 || args[0]!.startsWith('-') ? args : undefined;
}

interface LaneMessage {
  type: 'ready' | 'fatal' | 'result' | 'error';
  id?: number;
  ok?: boolean;
  error?: string;
}

interface PendingRun {
  id: number;
  settle: (result: RunOnceResult | Error) => void;
}

/**
 * A lane backed by one long-lived Vitest (`vitestLane.mjs`) in its own process, started on the
 * first run. A run that exceeds the timeout is failed and its process killed with everything it
 * started; the next run starts a fresh one.
 */
class WarmVitestLane implements Lane {
  private child: ChildProcess | undefined;
  private starting: Promise<ChildProcess> | undefined;
  private pending: PendingRun | undefined;
  private readonly pendingChanges = new Set<string>();
  private output = '';
  private nextId = 0;

  constructor(
    readonly dir: string,
    private readonly options: {
      args: string[];
      timeoutMs: number;
      maxWorkers?: number;
      script?: string;
    }
  ) {}

  changed(file: string): void {
    this.pendingChanges.add(file);
  }

  async run(files: string[], options: { mutant?: boolean } = {}): Promise<RunOnceResult> {
    if (files.length === 0) return { ok: true };
    const child = await this.start();
    const changed = [...this.pendingChanges];
    this.pendingChanges.clear();
    const id = (this.nextId += 1);
    const outcome = await new Promise<RunOnceResult | Error>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.stop();
        const error = `fireguard: test run timed out after ${this.options.timeoutMs}ms`;
        resolve({ ok: false, error });
      }, this.options.timeoutMs);
      this.pending = {
        id,
        settle: (result) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve(result);
        },
      };
      child.send({ type: 'run', id, files, passWithNoTests: Boolean(options.mutant), changed });
    });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const grace = setTimeout(() => this.stop(), CLOSE_GRACE_MS);
    child.send({ type: 'close' });
    await exited;
    clearTimeout(grace);
    this.child = undefined;
    this.starting = undefined;
  }

  private start(): Promise<ChildProcess> {
    this.starting ??= new Promise<ChildProcess>((resolve, reject) => {
      const { maxWorkers } = this.options;
      const env =
        maxWorkers === undefined
          ? process.env
          : { ...process.env, VITEST_MAX_WORKERS: String(maxWorkers) };
      const script = this.options.script ?? LANE_SCRIPT;
      const child = spawn(process.execPath, [script, JSON.stringify(this.options.args)], {
        cwd: this.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // Off Windows the lane leads its own process group, so killTree reaches its workers.
        detached: process.platform !== 'win32',
      });
      this.child = child;
      const keep = (chunk: Buffer): void => {
        this.output = `${this.output}${chunk.toString()}`.slice(-OUTPUT_TAIL);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      child.on('error', reject);
      child.on('message', (message: LaneMessage) => {
        if (message.type === 'ready') resolve(child);
        else if (message.type !== 'fatal') this.onResult(message);
        else reject(new Error(`vitest could not start in ${this.dir}: ${message.error}`));
      });
      child.on('exit', (code, signal) => {
        const why = `vitest lane exited (${signal ?? code})`;
        reject(new Error(`${why} before it was ready: ${this.output.trim()}`));
        this.onExit(child, why);
      });
    });
    return this.starting;
  }

  private onResult(message: LaneMessage): void {
    if (!this.pending || message.id !== this.pending.id) return;
    if (message.type === 'error') {
      this.pending.settle(new Error(`vitest lane failed in ${this.dir}: ${message.error}`));
    } else {
      this.pending.settle(message.ok ? { ok: true } : { ok: false, error: message.error });
    }
  }

  private onExit(child: ChildProcess, why: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.starting = undefined;
    // Like a `vitest run` that crashed: the run failed.
    this.pending?.settle({ ok: false, error: `${why} during a run: ${this.output.trim()}` });
  }

  /** Kills the lane and everything it started; the next run starts a new one. */
  private stop(): void {
    const child = this.child;
    this.child = undefined;
    this.starting = undefined;
    killTree(child?.pid);
  }
}

/** A lane that starts `testCommand` for every run, for commands that are not plain vitest. */
function createCommandLane(dir: string, config: FireguardConfig, maxWorkers?: number): Lane {
  const plain = createVitestRunner({ cwd: dir, config, maxWorkers });
  const mutant = createVitestRunner({ cwd: dir, config, maxWorkers, mutantRun: true });
  return {
    dir,
    run: (files, options) => (options?.mutant ? mutant : plain)(files),
    changed: () => {},
    close: async () => {},
  };
}

/**
 * The lane for one workspace: a warm Vitest when `testCommand` runs vitest, otherwise the
 * command started per run. `maxWorkers` caps each run's vitest workers so lanes share the CPUs.
 */
export function createLane(options: {
  dir: string;
  config: FireguardConfig;
  maxWorkers?: number;
  /** Test seam: the lane script. */
  script?: string;
}): Lane {
  const { dir, config, maxWorkers } = options;
  const args = vitestArgs(config.testCommand);
  if (!args) return createCommandLane(dir, config, maxWorkers);
  return new WarmVitestLane(dir, {
    args,
    timeoutMs: config.testTimeoutMs,
    maxWorkers,
    script: options.script,
  });
}
