import type {
  Execution,
  FireguardReport,
  FlakeGateResult,
  MutationGateResult,
} from './types.js';

function executionLine(execution: Execution): string {
  const runner =
    execution.runner === 'warm' ? 'one long-lived vitest per lane' : 'testCommand per run';
  if (execution.workspace === 'committed') {
    const lanes = execution.lanes === 1 ? '1 lane' : `${execution.lanes} lanes at a time`;
    return `Ran: ${lanes}, each in a snapshot of the committed tree (${runner})`;
  }
  const reason = execution.fallbackReason ? `; ${execution.fallbackReason}` : '';
  return `Ran: one at a time in the working tree (${runner}${reason})`;
}

function changedLinesLine(mutation: MutationGateResult): string | undefined {
  const skipped = mutation.unchangedLineMutants;
  if (skipped === undefined) return undefined;
  return `  changed lines only: ${mutation.total} mutants on changed lines, ${skipped} on unchanged lines not run`;
}

function formatModuleTests(moduleTests: Record<string, number> | undefined): string {
  return Object.entries(moduleTests ?? {})
    .map(([path, count]) =>
      count === 0 ? `${path}=0 (no graded test imports it)` : `${path}=${count}`
    )
    .join(', ');
}

function mutationLines(mutation: MutationGateResult): string[] {
  const lines = [
    `Gate 3 Mutation: ${mutation.pass ? 'PASS' : 'FAIL'}`,
    `  score=${mutation.score}% killed=${mutation.killed} survived=${mutation.survived} total=${mutation.total}`,
  ];
  const changedLines = changedLinesLine(mutation);
  if (changedLines) {
    lines.push(changedLines);
  }
  const perModule = formatModuleTests(mutation.moduleTests);
  if (perModule) {
    lines.push(`  tests per module: ${perModule}`);
  }
  for (const survivor of mutation.survivors.slice(0, 20)) {
    lines.push(`  - survivor ${survivor.file}:${survivor.line} ${survivor.description}`);
  }
  return lines;
}

function flakeLines(flake: FlakeGateResult): string[] {
  return [
    `Gate 2 Flake: ${flake.pass ? 'PASS' : 'FAIL'}`,
    `  executed=${flake.runs}/${flake.configuredRuns} failures=${flake.failures} rate=${flake.flakeRate} failFast=${flake.failFast}`,
    ...flake.failedRuns.map((failed) => `  - run #${failed.run}: ${failed.error}`),
  ];
}

/** What was graded, and how the lanes ran when they did. */
function scopeLines(report: FireguardReport): string[] {
  const lines = [
    `Base ref: ${report.scope.baseRef}`,
    `Graded tests: ${report.scope.gradedTestFiles.join(', ') || '(none)'}`,
    `Changed modules: ${report.scope.changedModules.join(', ') || '(none)'}`,
  ];
  if (report.execution) lines.push(executionLine(report.execution));
  return lines;
}

export function formatHumanReport(report: FireguardReport): string {
  const lines: string[] = [];
  lines.push('════════════════════════════════════════');
  lines.push(`FIREGUARD GRADE: ${report.grade.letter} (score ${report.grade.score})`);
  lines.push('════════════════════════════════════════');

  if (report.skipped) {
    lines.push(`Skipped: ${report.skipReason ?? 'nothing to grade'}`);
    return lines.join('\n');
  }

  lines.push(...scopeLines(report));
  lines.push('');

  for (const reason of report.grade.reasons) {
    lines.push(`• ${reason}`);
  }
  lines.push('');

  const ast = report.gates.ast;
  if (ast) {
    lines.push(`Gate 1 AST: ${ast.pass ? 'PASS' : 'FAIL'}`);
    lines.push(
      `  asserts=${ast.assertionCount} mocks=${ast.mockCount} ratio=${ast.mockToAssertRatio.toFixed(2)} tautology=${ast.tautologicalRatio.toFixed(2)}`
    );
    for (const finding of ast.findings) {
      lines.push(`  - ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
    }
  }

  const flake = report.gates.flake;
  if (flake) {
    lines.push(...flakeLines(flake));
  }

  const mutation = report.gates.mutation;
  if (mutation) {
    lines.push(...mutationLines(mutation));
  }

  return lines.join('\n');
}

export function formatJsonReport(report: FireguardReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
