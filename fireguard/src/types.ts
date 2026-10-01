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
   * Graded test files each module's mutants ran against (module path -> count). Present when
   * mutants were scoped to the tests that transitively import their module; 0 means no graded
   * test reaches the module, so every one of its mutants counted as survived.
   */
  moduleTests?: Record<string, number>;
}

export type GateResult = AstGateResult | FlakeGateResult | MutationGateResult;

export interface GradeResult {
  letter: LetterGrade;
  score: number;
  reasons: string[];
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
  skipped: boolean;
  skipReason?: string;
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
