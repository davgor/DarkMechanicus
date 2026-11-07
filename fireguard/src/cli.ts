import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { getChangedLines, getGitDiffEntries, readCommittedFile } from './processAdapters.js';
import {
  formatPrMarkdown,
  postPrCommentViaGithub,
  resolvePullNumberFromEvent,
} from './prComment.js';
import { formatHumanReport, formatJsonReport } from './report.js';
import { runFireguard, type RunFireguardDeps } from './runFireguard.js';
import { mergeShards, parseShard } from './sharding.js';
import type { FireguardConfig, FireguardReport } from './types.js';
import { openLanes } from './workspaceLanes.js';

export interface CliOptions {
  cwd?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readFileSyncFn?: (path: string, encoding: 'utf8') => string;
  writeFileSyncFn?: (path: string, data: string) => void;
  appendFileSyncFn?: (path: string, data: string) => void;
  postComment?: typeof postPrCommentViaGithub;
  /** Test seam — overrides the default git/vitest-backed runner. */
  runFireguardFn?: (deps: RunFireguardDeps) => Promise<FireguardReport>;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

/** Git/vitest/filesystem-backed dependencies for a real run: everything graded is committed. */
function createDeps(cwd: string, config: FireguardConfig): RunFireguardDeps {
  const { baseRef } = config;
  return {
    config,
    getDiffEntries: () => getGitDiffEntries({ cwd, baseRef }),
    readFile: (path) => readCommittedFile(cwd, path),
    getChangedLines: (paths) => getChangedLines({ cwd, baseRef, paths }),
    openLanes: () => openLanes({ cwd, config }),
  };
}

export async function runCli(options: CliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const readFile = options.readFileSyncFn ?? ((path, encoding) => readFileSync(path, encoding));
  const writeFile = options.writeFileSyncFn ?? ((path, data) => writeFileSync(path, data, 'utf8'));
  const appendFile =
    options.appendFileSyncFn ?? ((path, data) => appendFileSync(path, data, 'utf8'));
  const postComment = options.postComment ?? postPrCommentViaGithub;

  const json = argv.includes('--json');
  const commentPr = argv.includes('--comment-pr');
  const help = argv.includes('--help') || argv.includes('-h');
  const markdownOut = flagValue(argv, '--markdown-out');
  const jsonOut = flagValue(argv, '--json-out');
  const shardArg = flagValue(argv, '--shard');
  const mergeDirectory = flagValue(argv, '--merge-shards');

  if (help) {
    stdout(`fireguard — deterministic unit-test quality grader

Usage:
  fireguard [--json] [--comment-pr] [--markdown-out path] [--json-out path]

Grades committed, added or modified unit tests (git diff baseRef...HEAD, default main):
  Gate 1  AST mock/assert/tautology/empty checks
  Gate 2  Flakiness (default 100 isolated runs, 0% flake; fail-fast)
  Gate 3  Mutation score on the changed lines of changed production modules (≥75%); each
          mutant runs the nearest importing tests first, the rest only if it survives them

Tests run in temporary snapshots of the committed tree (HEAD), so uncommitted edits are not
graded and the working tree is never mutated.

Speed:
  FIREGUARD_CONCURRENCY  lanes: flake runs or mutants tested at once, each lane a snapshot
                         with one long-lived vitest (default: 1 per 3 CPUs)

PR integration:
  --comment-pr     Upsert a sticky grade comment on the current GitHub PR
                   (uses GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH)
  --markdown-out   Write PR markdown to a file
  --json-out       Write JSON report to a file
  --shard i/n     Execute disjoint flake-run/module partitions (no final grade/comment)
  --merge-shards  Directory of shard JSON reports; validate and issue the combined grade
  --shard-count n Expected report count when merging (required)

Exit codes:
  0  pass (grade not F)
  1  quality failure (grade F)
  2  tool error
`);
    return 0;
  }

  let report: FireguardReport;
  try {
    const config = loadConfig({ cwd, env });
    const run = options.runFireguardFn ?? runFireguard;
    if (argv.includes('--shard') && !shardArg) throw new Error('--shard requires index/count');
    if (argv.includes('--merge-shards') && !mergeDirectory) throw new Error('--merge-shards requires a directory');
    if (shardArg && (mergeDirectory || commentPr)) throw new Error('shards cannot merge or post PR comments');
    const deps = createDeps(cwd, config);
    if (shardArg || mergeDirectory) {
      const revision = (ref: string) => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`],
        { cwd, encoding: 'utf8' }).trim();
      const identity = { head: revision('HEAD'), base: revision(config.baseRef) };
      if (mergeDirectory) {
        const count = Number(flagValue(argv, '--shard-count'));
        const reports = readdirSync(mergeDirectory).filter((name) => name.endsWith('.json'))
          .sort().map((name) => JSON.parse(readFile(join(mergeDirectory, name), 'utf8')) as FireguardReport);
        report = mergeShards(reports, count, identity);
      } else {
        deps.shard = { ...parseShard(shardArg!), ...identity };
        report = await run(deps);
      }
    } else {
      report = await run(deps);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`fireguard error: ${message}\n`);
    return 2;
  }

  if (json) {
    stdout(formatJsonReport(report));
  } else {
    stdout(report.shard ? `fireguard shard ${report.shard.index}/${report.shard.count} complete; final grade deferred to aggregation\n`
      : `${formatHumanReport(report)}\n`);
  }

  const markdown = formatPrMarkdown(report);
  if (markdownOut) {
    writeFile(markdownOut, markdown);
  }
  if (jsonOut) {
    writeFile(jsonOut, formatJsonReport(report));
  }

  const stepSummary = env.GITHUB_STEP_SUMMARY;
  if (stepSummary && !report.shard) {
    try {
      // Append — never truncate other job summary content.
      appendFile(stepSummary, `${markdown}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr(`fireguard warning: could not write GITHUB_STEP_SUMMARY: ${message}\n`);
    }
  }

  if (commentPr) {
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    const repository = env.GITHUB_REPOSITORY;
    const pullNumber =
      (env.FIREGUARD_PULL_NUMBER ? Number(env.FIREGUARD_PULL_NUMBER) : undefined) ??
      resolvePullNumberFromEvent(env.GITHUB_EVENT_PATH, (path) => readFile(path, 'utf8'));

    const onPullRequest =
      env.GITHUB_EVENT_NAME === 'pull_request' ||
      env.GITHUB_EVENT_NAME === 'pull_request_target' ||
      Boolean(env.FIREGUARD_PULL_NUMBER);

    if (!token || !repository || !pullNumber) {
      if (env.GITHUB_ACTIONS === 'true' && !onPullRequest) {
        stderr('fireguard: --comment-pr skipped (not a pull_request event)\n');
      } else {
        stderr(
          'fireguard error: --comment-pr requires GITHUB_TOKEN, GITHUB_REPOSITORY, and a pull request number\n'
        );
        return 2;
      }
    } else {
      try {
        const action = await postComment({
          token,
          repository,
          pullNumber,
          body: markdown,
        });
        stdout(`fireguard: PR comment ${action} (grade ${report.grade.letter})\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(`fireguard error: failed to post PR comment: ${message}\n`);
        return 2;
      }
    }
  }

  if (report.shard) {
    return report.gates.ast?.pass === false || report.gates.flake?.pass === false ? 1 : 0;
  }
  if (report.grade.letter === 'F') {
    return 1;
  }
  return 0;
}
