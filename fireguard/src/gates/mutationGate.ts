import ts from 'typescript';
import type { RelatedTests } from '../importGraph.js';
import { runOnLanes } from '../lanePool.js';
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
  /** First line of the replaced code (1-based). */
  line: number;
  /** Last line of the replaced code; later than `line` for a condition that spans lines. */
  endLine: number;
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

/** Swaps that flip a comparison count as conditional inversions; the rest are operator swaps. */
const COMPARISON_TOKENS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
]);

/** One replacement of `source[start, end)`, before it gets an id and line numbers. */
interface Edit {
  start: number;
  end: number;
  replacement: string;
  kind: MutantKind;
  description: string;
}

function binaryEdit(node: ts.BinaryExpression, sourceFile: ts.SourceFile): Edit | undefined {
  const swap = BINARY_SWAPS[node.operatorToken.kind];
  if (swap === undefined) return undefined;
  const opText = ts.tokenToString(swap) ?? '??';
  return {
    start: node.operatorToken.getStart(sourceFile),
    end: node.operatorToken.getEnd(),
    replacement: opText,
    kind: COMPARISON_TOKENS.has(node.operatorToken.kind)
      ? 'conditional-inversion'
      : 'operator-swap',
    description: `swap operator to ${opText}`,
  };
}

function returnEdit(expr: ts.Expression, sourceFile: ts.SourceFile): Edit | undefined {
  const start = expr.getStart(sourceFile);
  const end = expr.getEnd();
  if (ts.isNumericLiteral(expr)) {
    const next = String(Number(expr.text) + 1);
    const description = `tweak numeric return ${expr.text} -> ${next}`;
    return { start, end, replacement: next, kind: 'return-value-tweak', description };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    const next = expr.kind === ts.SyntaxKind.TrueKeyword ? 'false' : 'true';
    const description = `invert boolean return to ${next}`;
    return { start, end, replacement: next, kind: 'return-value-tweak', description };
  }
  return undefined;
}

/** Invert if conditions: if (cond) -> if (!(cond)) */
function ifEdit(node: ts.IfStatement, source: string, sourceFile: ts.SourceFile): Edit | undefined {
  if (ts.isPrefixUnaryExpression(node.expression)) return undefined;
  const start = node.expression.getStart(sourceFile);
  const end = node.expression.getEnd();
  return {
    start,
    end,
    replacement: `!(${source.slice(start, end)})`,
    kind: 'conditional-inversion',
    description: 'invert if condition',
  };
}

function editsAt(node: ts.Node, source: string, sourceFile: ts.SourceFile): Edit[] {
  const edits: Array<Edit | undefined> = [];
  if (ts.isBinaryExpression(node)) edits.push(binaryEdit(node, sourceFile));
  if (ts.isReturnStatement(node) && node.expression) {
    edits.push(returnEdit(node.expression, sourceFile));
  }
  if (ts.isIfStatement(node)) edits.push(ifEdit(node, source, sourceFile));
  return edits.filter((edit): edit is Edit => edit !== undefined);
}

export function generateMutants(file: string, source: string): Mutant[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const lineOf = (position: number): number =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const mutants: Mutant[] = [];

  const visit = (node: ts.Node): void => {
    for (const edit of editsAt(node, source, sourceFile)) {
      mutants.push({
        id: `${file}#${mutants.length + 1}`,
        file,
        line: lineOf(edit.start),
        endLine: lineOf(Math.max(edit.start, edit.end - 1)),
        kind: edit.kind,
        description: edit.description,
        mutatedSource: `${source.slice(0, edit.start)}${edit.replacement}${source.slice(edit.end)}`,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return mutants;
}

/** Whether a mutant replaces code on at least one of the given lines. */
export function touchesLines(mutant: Mutant, lines: ReadonlySet<number>): boolean {
  for (let line = mutant.line; line <= mutant.endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

export function scoreMutations(options: {
  killed: number;
  survived: number;
  minScore: number;
  survivors: MutationSurvivor[];
  modules: string[];
  moduleTests?: Record<string, number>;
  unchangedLineMutants?: number;
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
  // Only scoped runs carry these fields, so unscoped results keep their previous shape.
  if (options.moduleTests) result.moduleTests = options.moduleTests;
  if (options.unchangedLineMutants !== undefined) {
    result.unchangedLineMutants = options.unchangedLineMutants;
  }
  return result;
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

interface MutationOptions {
  config: FireguardConfig;
  modules: Array<{ path: string; source: string }>;
  relatedTests: string[];
  /**
   * Graded tests that can kill the mutants of one module (those that transitively import it),
   * nearest first. When omitted, every module's mutants run against all of `relatedTests`.
   */
  relatedTestsFor?: (modulePath: string) => RelatedTests;
  /**
   * Lines the diff changed in each module (new side, 1-based). When given, only mutants that
   * touch a changed line run; a module missing from the map has no changed lines. When omitted,
   * every mutant runs.
   */
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** One applier per lane; mutants are spread over the lanes, one per lane at a time. */
  appliers: ApplyAndTest[];
}

function collectJobs(options: MutationOptions) {
  const moduleTests: Record<string, number> = {};
  const jobs: MutantJob[] = [];
  let unchangedLineMutants = 0;
  const noLines: ReadonlySet<number> = new Set();
  for (const mod of options.modules) {
    const tiers = options.relatedTestsFor
      ? options.relatedTestsFor(mod.path)
      : { nearest: options.relatedTests, farther: [] };
    moduleTests[mod.path] = tiers.nearest.length + tiers.farther.length;
    // No test can reach a module without batches, so its mutants survive without being applied.
    const batches = [tiers.nearest, tiers.farther].filter((batch) => batch.length > 0);
    const lines = options.changedLines && (options.changedLines.get(mod.path) ?? noLines);
    for (const mutant of generateMutants(mod.path, mod.source)) {
      if (lines && !touchesLines(mutant, lines)) unchangedLineMutants += 1;
      else jobs.push({ mod, mutant, batches });
    }
  }
  return { jobs, moduleTests, unchangedLineMutants };
}

export async function runMutationGate(options: MutationOptions): Promise<MutationGateResult> {
  const { jobs, moduleTests, unchangedLineMutants } = collectJobs(options);
  const killedByJob: boolean[] = [];
  await runOnLanes(jobs.length, options.appliers, async (index, applyAndTest) => {
    killedByJob[index] = await isKilled(jobs[index]!, applyAndTest);
  });
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
    unchangedLineMutants: options.changedLines ? unchangedLineMutants : undefined,
  });
}
