import ts from 'typescript';
import type { RelatedTests } from '../importGraph.js';
import type {
  ApplyAndTest,
  FireguardConfig,
  MutationGateResult,
  MutationSurvivor,
} from '../types.js';

export type MutantKind = 'conditional-inversion' | 'operator-swap' | 'return-value-tweak';

export interface Mutant {
  id: string;
  file: string;
  line: number;
  kind: MutantKind;
  description: string;
  mutatedSource: string;
}

const BINARY_SWAPS: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = {
  [ts.SyntaxKind.PlusToken]: ts.SyntaxKind.MinusToken,
  [ts.SyntaxKind.MinusToken]: ts.SyntaxKind.PlusToken,
  [ts.SyntaxKind.AsteriskToken]: ts.SyntaxKind.SlashToken,
  [ts.SyntaxKind.SlashToken]: ts.SyntaxKind.AsteriskToken,
  [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanToken,
  [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanToken,
  [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanEqualsToken,
  [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanEqualsToken,
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: ts.SyntaxKind.ExclamationEqualsEqualsToken,
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ts.SyntaxKind.EqualsEqualsEqualsToken,
};

function replaceRange(source: string, start: number, end: number, replacement: string): string {
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

export function generateMutants(file: string, source: string): Mutant[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const mutants: Mutant[] = [];
  let counter = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const swap = BINARY_SWAPS[node.operatorToken.kind];
      if (swap !== undefined) {
        const opText = ts.tokenToString(swap) ?? '??';
        const start = node.operatorToken.getStart(sourceFile);
        const end = node.operatorToken.getEnd();
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.operatorToken.getStart(sourceFile)).line +
          1;
        counter += 1;
        mutants.push({
          id: `${file}#${counter}`,
          file,
          line,
          kind:
            node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
            node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
              ? 'conditional-inversion'
              : 'operator-swap',
          description: `swap operator to ${opText}`,
          mutatedSource: replaceRange(source, start, end, opText),
        });
      }
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const expr = node.expression;
      if (ts.isNumericLiteral(expr)) {
        const start = expr.getStart(sourceFile);
        const end = expr.getEnd();
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        const next = String(Number(expr.text) + 1);
        counter += 1;
        mutants.push({
          id: `${file}#${counter}`,
          file,
          line,
          kind: 'return-value-tweak',
          description: `tweak numeric return ${expr.text} -> ${next}`,
          mutatedSource: replaceRange(source, start, end, next),
        });
      } else if (
        expr.kind === ts.SyntaxKind.TrueKeyword ||
        expr.kind === ts.SyntaxKind.FalseKeyword
      ) {
        const start = expr.getStart(sourceFile);
        const end = expr.getEnd();
        const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
        const next = expr.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true';
        counter += 1;
        mutants.push({
          id: `${file}#${counter}`,
          file,
          line,
          kind: 'return-value-tweak',
          description: `invert boolean return to ${next}`,
          mutatedSource: replaceRange(source, start, end, next),
        });
      }
    }

    // Invert if conditions: if (cond) -> if (!(cond))
    if (ts.isIfStatement(node) && node.expression && !ts.isPrefixUnaryExpression(node.expression)) {
      const start = node.expression.getStart(sourceFile);
      const end = node.expression.getEnd();
      const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      const original = source.slice(start, end);
      counter += 1;
      mutants.push({
        id: `${file}#${counter}`,
        file,
        line,
        kind: 'conditional-inversion',
        description: `invert if condition`,
        mutatedSource: replaceRange(source, start, end, `!(${original})`),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return mutants;
}

export function scoreMutations(options: {
  killed: number;
  survived: number;
  minScore: number;
  survivors: MutationSurvivor[];
  modules: string[];
  moduleTests?: Record<string, number>;
}): MutationGateResult {
  const total = options.killed + options.survived;
  const score = total === 0 ? 100 : Math.round((options.killed / total) * 100);
  const result: MutationGateResult = {
    name: 'mutation',
    pass: score >= options.minScore,
    killed: options.killed,
    survived: options.survived,
    total,
    score,
    survivors: options.survivors,
    modules: options.modules,
  };
  // Only scoped runs carry per-module counts, so unscoped results keep their previous shape.
  return options.moduleTests ? { ...result, moduleTests: options.moduleTests } : result;
}

interface MutantJob {
  mod: { path: string; source: string };
  mutant: Mutant;
  /** Test batches to try in order (nearest, then farther); empty when no test reaches the module. */
  batches: string[][];
}

/** A mutant is killed as soon as one batch fails, so farther tests run only for survivors. */
async function isKilled(job: MutantJob, applyAndTest: ApplyAndTest): Promise<boolean> {
  for (const relatedTests of job.batches) {
    const result = await applyAndTest({
      file: job.mod.path,
      originalSource: job.mod.source,
      mutatedSource: job.mutant.mutatedSource,
      relatedTests,
    });
    // ok:false means tests failed => mutant killed
    if (!result.ok) return true;
  }
  return false;
}

/**
 * Each lane takes the next job as soon as it is free, so lanes never run two jobs at once.
 * After a job throws, no lane starts another; the first error is rethrown once every lane
 * has finished its job in flight (so its workspace is no longer in use).
 */
async function runOnLanes<T>(
  jobs: T[],
  appliers: ApplyAndTest[],
  run: (job: T, applyAndTest: ApplyAndTest) => Promise<boolean>
): Promise<boolean[]> {
  if (appliers.length === 0) throw new Error('fireguard: no mutation lanes to run mutants on');
  const results: boolean[] = [];
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    appliers.map(async (applyAndTest) => {
      while (failure === undefined && next < jobs.length) {
        const index = next;
        next += 1;
        try {
          results[index] = await run(jobs[index]!, applyAndTest);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure !== undefined) throw failure.error;
  return results;
}

export async function runMutationGate(options: {
  config: FireguardConfig;
  modules: Array<{ path: string; source: string }>;
  relatedTests: string[];
  /**
   * Graded tests that can kill the mutants of one module (those that transitively import it),
   * nearest first. When omitted, every module's mutants run against all of `relatedTests`.
   */
  relatedTestsFor?: (modulePath: string) => RelatedTests;
  /** One applier per lane; mutants are spread over the lanes, one per lane at a time. */
  appliers: ApplyAndTest[];
}): Promise<MutationGateResult> {
  const moduleTests: Record<string, number> = {};
  const jobs: MutantJob[] = [];
  for (const mod of options.modules) {
    const tiers = options.relatedTestsFor
      ? options.relatedTestsFor(mod.path)
      : { nearest: options.relatedTests, farther: [] };
    moduleTests[mod.path] = tiers.nearest.length + tiers.farther.length;
    // No test can reach a module without batches, so its mutants survive without being applied.
    const batches = [tiers.nearest, tiers.farther].filter((batch) => batch.length > 0);
    for (const mutant of generateMutants(mod.path, mod.source)) {
      jobs.push({ mod, mutant, batches });
    }
  }

  const killedByJob = await runOnLanes(jobs, options.appliers, isKilled);
  let killed = 0;
  const survivors: MutationSurvivor[] = [];
  jobs.forEach((job, index) => {
    if (killedByJob[index]) {
      killed += 1;
      return;
    }
    survivors.push({
      file: job.mutant.file,
      line: job.mutant.line,
      description: `${job.mutant.kind}: ${job.mutant.description}`,
    });
  });

  return scoreMutations({
    killed,
    survived: survivors.length,
    minScore: options.config.thresholds.minMutationScore,
    survivors,
    modules: options.modules.map((m) => m.path),
    moduleTests: options.relatedTestsFor ? moduleTests : undefined,
  });
}
