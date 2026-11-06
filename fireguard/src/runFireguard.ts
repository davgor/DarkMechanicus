import { runAstGate } from './gates/astGate.js';
import { runFlakeGate } from './gates/flakeGate.js';
import { runMutationGate } from './gates/mutationGate.js';
import { computeGrade } from './grade.js';
import { resolveGitScope } from './gitScope.js';
import { buildRelatedTests, type RelatedTests } from './importGraph.js';
import type {
  DiffEntry,
  FireguardConfig,
  FireguardReport,
  GitScope,
  Lanes,
  MutationGateResult,
} from './types.js';

export interface RunFireguardDeps {
  config: FireguardConfig;
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
      config: deps.config,
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
  scopePayload: FireguardReport['scope']
): FireguardReport {
  // Fail closed: production module changes without graded test updates cannot earn a free A.
  if (scope.changedModules.length > 0) {
    return {
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

export async function runFireguard(deps: RunFireguardDeps): Promise<FireguardReport> {
  const entries = await deps.getDiffEntries();
  const scope = resolveGitScope({ config: deps.config, entries });

  const scopePayload = {
    baseRef: deps.config.baseRef,
    gradedTestFiles: scope.gradedTestFiles,
    changedModules: scope.changedModules,
  };
  if (scope.gradedTestFiles.length === 0) return untestedReport(scope, scopePayload);

  const gates: FireguardReport['gates'] = {};

  const files = await Promise.all(
    scope.gradedTestFiles.map(async (path) => ({
      path,
      source: await deps.readFile(path),
    }))
  );
  gates.ast = runAstGate({ config: deps.config, files });
  if (!gates.ast.pass) {
    return {
      grade: computeGrade(gates),
      gates,
      scope: scopePayload,
      skipped: false,
    };
  }

  const execution = await runLaneGates(deps, scope, gates);
  return {
    grade: computeGrade(gates),
    gates,
    scope: scopePayload,
    execution,
    skipped: false,
  };
}
