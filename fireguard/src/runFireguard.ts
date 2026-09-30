import { runAstGate } from './gates/astGate.js';
import { runFlakeGate } from './gates/flakeGate.js';
import { runMutationGate } from './gates/mutationGate.js';
import { computeGrade } from './grade.js';
import { resolveGitScope } from './gitScope.js';
import { buildRelatedTests } from './importGraph.js';
import type {
  DiffEntry,
  FireguardConfig,
  FireguardReport,
  GitScope,
  MutationGateResult,
  RunOnceResult,
  TestRunner,
} from './types.js';

export interface RunFireguardDeps {
  config: FireguardConfig;
  getDiffEntries: () => Promise<DiffEntry[]>;
  readFile: (path: string) => Promise<string>;
  runOnce: TestRunner;
  applyAndTest: (input: {
    file: string;
    originalSource: string;
    mutatedSource: string;
    relatedTests: string[];
  }) => Promise<RunOnceResult>;
  /**
   * Whether a repo-relative path is a regular file. With `readFileSync`, lets the mutation gate
   * run each module's mutants only against the graded tests that transitively import it.
   * Without both probes every graded test runs for every mutant.
   */
  fileExists?: (path: string) => boolean;
  /** Synchronous repo-relative reader for the import graph: null when missing or unreadable. */
  readFileSync?: (path: string) => string | null;
}

/** Lookup from a changed module to the graded tests that can kill its mutants, if scopable. */
function createRelatedTestsLookup(
  deps: RunFireguardDeps,
  scope: GitScope
): ((modulePath: string) => string[]) | undefined {
  const { fileExists, readFileSync } = deps;
  if (!fileExists || !readFileSync) return undefined;
  const related = buildRelatedTests({
    tests: scope.gradedTestFiles,
    modules: scope.changedModules,
    readFile: readFileSync,
    exists: fileExists,
  });
  return (modulePath) => related.get(modulePath) ?? [];
}

async function runMutationStage(
  deps: RunFireguardDeps,
  scope: GitScope
): Promise<MutationGateResult> {
  const modules = await Promise.all(
    scope.changedModules.map(async (path) => ({
      path,
      source: await deps.readFile(path),
    }))
  );
  return runMutationGate({
    config: deps.config,
    modules,
    relatedTests: scope.gradedTestFiles,
    relatedTestsFor: createRelatedTestsLookup(deps, scope),
    applyAndTest: deps.applyAndTest,
  });
}

export async function runFireguard(deps: RunFireguardDeps): Promise<FireguardReport> {
  const entries = await deps.getDiffEntries();
  const scope = resolveGitScope({ config: deps.config, entries });

  const scopePayload = {
    baseRef: deps.config.baseRef,
    gradedTestFiles: scope.gradedTestFiles,
    changedModules: scope.changedModules,
  };

  // Fail closed: production module changes without graded test updates cannot earn a free A.
  if (scope.gradedTestFiles.length === 0 && scope.changedModules.length > 0) {
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

  if (scope.gradedTestFiles.length === 0) {
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

  gates.flake = await runFlakeGate({
    config: deps.config,
    files: scope.gradedTestFiles,
    runOnce: deps.runOnce,
  });
  if (!gates.flake.pass) {
    return {
      grade: computeGrade(gates),
      gates,
      scope: scopePayload,
      skipped: false,
    };
  }

  if (scope.changedModules.length > 0) {
    gates.mutation = await runMutationStage(deps, scope);
  }

  return {
    grade: computeGrade(gates),
    gates,
    scope: scopePayload,
    skipped: false,
  };
}
