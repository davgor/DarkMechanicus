import ts from 'typescript';
import type {
  FireguardConfig,
  MutationGateResult,
  MutationSurvivor,
  RunOnceResult,
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

type ApplyAndTest = (input: {
  file: string;
  originalSource: string;
  mutatedSource: string;
  relatedTests: string[];
}) => Promise<RunOnceResult>;

async function isKilled(input: {
  mod: { path: string; source: string };
  mutant: Mutant;
  tests: string[];
  applyAndTest: ApplyAndTest;
}): Promise<boolean> {
  // No test can reach this module, so nothing can kill the mutant: skip applying it.
  if (input.tests.length === 0) return false;
  const result = await input.applyAndTest({
    file: input.mod.path,
    originalSource: input.mod.source,
    mutatedSource: input.mutant.mutatedSource,
    relatedTests: input.tests,
  });
  // ok:false means tests failed => mutant killed
  return !result.ok;
}

export async function runMutationGate(options: {
  config: FireguardConfig;
  modules: Array<{ path: string; source: string }>;
  relatedTests: string[];
  /**
   * Graded tests that can kill the mutants of one module (those that transitively import it).
   * When omitted, every module's mutants run against all of `relatedTests`.
   */
  relatedTestsFor?: (modulePath: string) => string[];
  applyAndTest: ApplyAndTest;
}): Promise<MutationGateResult> {
  let killed = 0;
  let survived = 0;
  const survivors: MutationSurvivor[] = [];
  const moduleTests: Record<string, number> = {};

  for (const mod of options.modules) {
    const tests = options.relatedTestsFor
      ? options.relatedTestsFor(mod.path)
      : options.relatedTests;
    moduleTests[mod.path] = tests.length;
    for (const mutant of generateMutants(mod.path, mod.source)) {
      if (await isKilled({ mod, mutant, tests, applyAndTest: options.applyAndTest })) {
        killed += 1;
      } else {
        survived += 1;
        survivors.push({
          file: mutant.file,
          line: mutant.line,
          description: `${mutant.kind}: ${mutant.description}`,
        });
      }
    }
  }

  return scoreMutations({
    killed,
    survived,
    minScore: options.config.thresholds.minMutationScore,
    survivors,
    modules: options.modules.map((m) => m.path),
    moduleTests: options.relatedTestsFor ? moduleTests : undefined,
  });
}
