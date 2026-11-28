import { runAstGate } from './gates/astGate.js';
import { runFlakeGate } from './gates/flakeGate.js';
import { runMutationGate } from './gates/mutationGate.js';
import { computeGrade } from './grade.js';
import { resolveGitScope } from './gitScope.js';
import { buildRelatedTests, type RelatedTests } from './importGraph.js';
import { shardRunCount } from './partition.js';
import type {
  AstGateResult,
  DiffEntry,
  FireguardConfig,
  FireguardReport,
  GitScope,
  Lanes,
  MutationGateResult,
  ShardIdentity,
} from './types.js';

export interface RunFireguardDeps {
  config: FireguardConfig;
  revision: Pick<ShardIdentity, 'base' | 'head'>;
  shard?: ShardIdentity;
  getDiffEntries: () => Promise<DiffEntry[]>;
  /** A graded test as committed: the AST gate grades what the diff grades. */
  readFile: (path: string) => Promise<string>;
  /**
   * Lines the diff changed in each module (new side, 1-based). With it, the mutation gate runs
   * only mutants on changed lines; without it, every mutant of every changed module.
   */
  getChangedLines?: (
    modules: string[]
  ) => Promise<ReadonlyMap<string, ReadonlySet<number>>>;
  /**
   * Opens the lanes the flake and mutation gates run in; called only once the AST gate passes,
   * and always closed before `runFireguard` returns.
   */
  openLanes: () => Promise<Lanes>;
  /** Run gate 1 only (a row check's early signal): never open lanes, never run flake or mutation. */
  astOnly?: boolean;
}

/** Lookup from a changed module to the graded tests that can kill its mutants, if scopable. */
function createRelatedTestsLookup(
  lanes: Lanes,
  scope: GitScope
): ((modulePath: string) => RelatedTests) | undefined {
  const { fileExists, readFileSync } = lanes.source;
  if (!fileExists || !readFileSync) return undefined;
  const related = buildRelatedTests({
    tests: scope.gradedTestFiles,
    modules: scope.changedModules,
    readFile: readFileSync,
    exists: fileExists,
  });
  return (modulePath) => related.get(modulePath) ?? { nearest: [], farther: [] };
}

async function runMutationStage(
  deps: RunFireguardDeps,
  scope: GitScope,
  lanes: Lanes
): Promise<MutationGateResult> {
  // A shard reads every changed module: it runs its round-robin share of all their mutants.
  const modules = await Promise.all(
    scope.changedModules.map(async (path) => ({
      path,
      source: await lanes.source.readFile(path),
    }))
  );
  return runMutationGate({
    config: deps.config,
    modules,
    relatedTests: scope.gradedTestFiles,
    relatedTestsFor: createRelatedTestsLookup(lanes, scope),
    changedLines: await deps.getChangedLines?.(scope.changedModules),
    appliers: lanes.appliers,
    shard: deps.shard,
  });
}

/**
 * The flake gate, then (if it passes and modules changed) the mutation gate, on one set of lanes.
 * No mutant runs while flake runs do: a mutant that hangs or eats memory would slow the flake
 * runs beside it and could fail them.
 */
async function runLaneGates(
  deps: RunFireguardDeps,
  scope: GitScope,
  gates: FireguardReport['gates']
): Promise<FireguardReport['execution']> {
  const lanes = await deps.openLanes();
  try {
    gates.flake = await runFlakeGate({
      config: deps.shard ? {
        ...deps.config,
        thresholds: {
          ...deps.config.thresholds,
          agenticFlakinessRuns: shardRunCount(deps.config.thresholds.agenticFlakinessRuns, deps.shard),
        },
      } : deps.config,
      files: scope.gradedTestFiles,
      runners: lanes.runners,
    });
    if (gates.flake.pass && scope.changedModules.length > 0) {
      gates.mutation = await runMutationStage(deps, scope, lanes);
    }
    return lanes.execution;
  } finally {
    await lanes.close();
  }
}

/** The report for a diff with no graded tests, which no gate runs for. */
function untestedReport(
  scope: GitScope,
  scopePayload: FireguardReport['scope'],
  revision: FireguardReport['revision']
): FireguardReport {
  // Fail closed: production module changes without graded test updates cannot earn a free A.
  if (scope.changedModules.length > 0) {
    return {
      revision,
      grade: {
        letter: 'F',
        score: 0,
        reasons: ['production modules changed without graded unit test updates'],
      },
      gates: {},
      scope: scopePayload,
      skipped: false,
      skipReason: undefined,
    };
  }
  return {
    revision,
    grade: {
      letter: 'A',
      score: 100,
      reasons: ['no graded unit tests to evaluate'],
    },
    gates: {},
    scope: scopePayload,
    skipped: true,
    skipReason: 'No added/modified unit tests vs base ref',
  };
}

/** The diff's scope and, when it has graded tests, the AST gate over them as committed. */
export async function scopeAndAst(
  deps: Pick<RunFireguardDeps, 'config' | 'getDiffEntries' | 'readFile'>
): Promise<{ scope: GitScope; ast?: AstGateResult }> {
  const scope = resolveGitScope({ config: deps.config, entries: await deps.getDiffEntries() });
  if (scope.gradedTestFiles.length === 0) return { scope };
  const files = await Promise.all(
    scope.gradedTestFiles.map(async (path) => ({
      path,
      source: await deps.readFile(path),
    }))
  );
  return { scope, ast: runAstGate({ config: deps.config, files }) };
}

async function run(deps: RunFireguardDeps): Promise<FireguardReport> {
  const { scope, ast } = await scopeAndAst(deps);

  const scopePayload = {
    baseRef: deps.config.baseRef,
    gradedTestFiles: scope.gradedTestFiles,
    changedModules: scope.changedModules,
  };
  if (!ast) return untestedReport(scope, scopePayload, deps.revision);

  const gates: FireguardReport['gates'] = { ast };
  if (!ast.pass || deps.astOnly) {
    const grade = computeGrade(gates);
    if (ast.pass) grade.reasons = ['ast gate passed; flake and mutation gates not run (--ast-only)'];
    return {
      revision: deps.revision,
      grade,
      gates,
      scope: scopePayload,
      skipped: false,
    };
  }

  const execution = await runLaneGates(deps, scope, gates);
  return {
    revision: deps.revision,
    grade: computeGrade(gates),
    gates,
    scope: scopePayload,
    execution,
    skipped: false,
  };
}

export async function runFireguard(deps: RunFireguardDeps): Promise<FireguardReport> {
  const report = await run(deps);
  if (deps.shard) report.shard = { ...deps.shard, config: deps.config };
  if (deps.astOnly) report.astOnly = true;
  return report;
}
