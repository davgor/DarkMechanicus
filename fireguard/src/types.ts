export type LetterGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface FireguardThresholds {
  maxMockToAssertRatio: number;
  maxTautologicalRatio: number;
  minAssertionsPerFile: number;
  minMutationScore: number;
  flakinessRuns: number;
  agenticFlakinessRuns: number;
  maxFlakeRate: number;
}

export interface FireguardConfig {
  thresholds: FireguardThresholds;
  include: string[];
  exclude: string[];
  baseRef: string;
  testCommand: string;
  /**
   * Wall-clock limit for one test run. A run that exceeds it is killed (with everything it
   * started) and reported as failed, so a mutant that makes code loop forever counts as killed
   * and a hung flake run counts as flaky instead of hanging fireguard.
   */
  testTimeoutMs: number;
  /**
   * Lanes: flake runs or mutants tested at once, each lane in its own temporary snapshot of the
   * committed tree. Only when the snapshots cannot be made do the tests run in the working
   * tree, one run at a time.
   */
  concurrency: number;
}

export interface AstFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

export interface AstGateResult {
  name: 'ast';
  pass: boolean;
  assertionCount: number;
  mockCount: number;
  mockToAssertRatio: number;
  tautologicalCount: number;
  tautologicalRatio: number;
  emptyTests: Array<{ file: string; line: number; name: string }>;
  findings: AstFinding[];
}

export interface FlakeGateResult {
  name: 'flake';
  pass: boolean;
  /** How many runs were actually executed (may be < configuredRuns on fail-fast). */
  runs: number;
  /** Configured agentic flake run budget. */
  configuredRuns: number;
  failures: number;
  flakeRate: number;
  files: string[];
  failedRuns: Array<{ run: number; error: string }>;
  failFast: boolean;
}

export interface MutationSurvivor {
  file: string;
  line: number;
  description: string;
}

export interface MutationGateResult {
  name: 'mutation';
  pass: boolean;
  killed: number;
  survived: number;
  total: number;
  score: number;
  survivors: MutationSurvivor[];
  modules: string[];
  /**
   * Graded test files related to each module, nearest and farther (module path -> count).
   * Present when mutants were scoped to the tests that transitively import their module; 0 means
   * no graded test reaches the module, so every one of its mutants counted as survived.
   */
  moduleTests?: Record<string, number>;
  /**
   * Mutants generated on lines the diff left unchanged, which were not run. Present when mutants
   * were limited to the changed lines of each module.
   */
  unchangedLineMutants?: number;
}

/** Where and how the flake and mutation gates ran their tests. */
export interface Execution {
  /** Test runs at once, each in its own workspace. */
  lanes: number;
  /**
   * `committed`: temporary snapshots of the committed tree (HEAD), one per lane;
   * `working-tree`: the working tree itself, one run at a time.
   */
  workspace: 'committed' | 'working-tree';
  /** `warm`: one long-lived vitest per lane; `command`: `testCommand` started for every run. */
  runner: 'warm' | 'command';
  /** Why snapshots were wanted but the tests ran in the working tree. */
  fallbackReason?: string;
}

export type GateResult = AstGateResult | FlakeGateResult | MutationGateResult;

export interface GradeResult {
  letter: LetterGrade;
  score: number;
  reasons: string[];
}

export interface ShardIdentity {
  index: number;
  count: number;
  head: string;
  base: string;
}

export interface FireguardReport {
  grade: GradeResult;
  gates: {
    ast?: AstGateResult;
    flake?: FlakeGateResult;
    mutation?: MutationGateResult;
  };
  scope: {
    baseRef: string;
    /** Added or modified unit test files in scope for grading. */
    gradedTestFiles: string[];
    changedModules: string[];
  };
  /** How the flake and mutation gates ran; present once they ran through `runFireguard`. */
  execution?: Execution;
  skipped: boolean;
  skipReason?: string;
  /** Partial CI workload; only mergeShards may issue the final combined grade. */
  shard?: ShardIdentity & { config: FireguardConfig };
}

export interface GitScope {
  /** Added or modified unit test files matching include globs. */
  gradedTestFiles: string[];
  changedModules: string[];
}

export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface DiffEntry {
  status: DiffStatus;
  path: string;
  /** For renames, the new path is `path`; old may be provided. */
  oldPath?: string;
}

export interface RunOnceResult {
  ok: boolean;
  error?: string;
}

export type TestRunner = (files: string[]) => Promise<RunOnceResult>;

export interface MutantRun {
  file: string;
  originalSource: string;
  mutatedSource: string;
  relatedTests: string[];
}

/** Writes one mutant into a workspace, runs the given tests there, and restores the file. */
export type ApplyAndTest = (input: MutantRun) => Promise<RunOnceResult>;

/** The workspace the lanes run, read for mutation sources and the import graph. */
export interface WorkspaceSource {
  readFile: (path: string) => Promise<string>;
  /**
   * Whether a repo-relative path is a regular file. With `readFileSync`, lets the mutation gate
   * run each module's mutants only against the graded tests that transitively import it.
   * Without both probes every graded test runs for every mutant.
   */
  fileExists?: (path: string) => boolean;
  /** Synchronous repo-relative reader for the import graph: null when missing or unreadable. */
  readFileSync?: (path: string) => string | null;
}

/**
 * The workspaces the flake and mutation gates run tests in, one lane each. A lane runs one
 * thing at a time: a flake run or a mutant.
 */
export interface Lanes {
  /** One flake runner per lane. */
  runners: TestRunner[];
  /** One mutant applier per lane. */
  appliers: ApplyAndTest[];
  execution: Execution;
  source: WorkspaceSource;
  /** Stops the lanes and removes any snapshots. */
  close: () => Promise<void>;
}
