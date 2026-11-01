import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import type { FireguardConfig, FireguardThresholds } from './types.js';

export const DEFAULT_THRESHOLDS: FireguardThresholds = {
  maxMockToAssertRatio: 1.5,
  maxTautologicalRatio: 0.1,
  minAssertionsPerFile: 1,
  minMutationScore: 75,
  flakinessRuns: 3,
  agenticFlakinessRuns: 100,
  maxFlakeRate: 0,
};

export const DEFAULT_CONFIG: FireguardConfig = {
  thresholds: { ...DEFAULT_THRESHOLDS },
  include: ['src/**/*.{test,spec}.{ts,tsx}'],
  exclude: ['**/__mocks__/**', '**/node_modules/**', 'e2e/**'],
  baseRef: 'main',
  testCommand: 'npx vitest run',
  testTimeoutMs: 300_000,
  // A lane per three CPUs: 4 on a 12-core machine; machines under 6 cores keep one in-place lane.
  concurrency: Math.max(1, Math.floor(availableParallelism() / 3)),
};

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
  readFile?: (absolutePath: string) => string;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function mergeConfig(
  base: FireguardConfig,
  override: DeepPartial<FireguardConfig>
): FireguardConfig {
  return {
    ...base,
    ...override,
    thresholds: {
      ...base.thresholds,
      ...(override.thresholds ?? {}),
    },
    include: override.include ?? base.include,
    exclude: override.exclude ?? base.exclude,
  };
}

function applyEnvOverrides(
  config: FireguardConfig,
  env: Record<string, string | undefined>
): FireguardConfig {
  const next = mergeConfig(config, {});
  if (env.FIREGUARD_MIN_MUTATION_SCORE) {
    next.thresholds.minMutationScore = Number(env.FIREGUARD_MIN_MUTATION_SCORE);
  }
  if (env.FIREGUARD_MAX_MOCK_RATIO) {
    next.thresholds.maxMockToAssertRatio = Number(env.FIREGUARD_MAX_MOCK_RATIO);
  }
  if (env.FIREGUARD_AGENTIC_FLAKINESS_RUNS) {
    next.thresholds.agenticFlakinessRuns = Number(env.FIREGUARD_AGENTIC_FLAKINESS_RUNS);
  }
  if (env.FIREGUARD_BASE_REF) {
    next.baseRef = env.FIREGUARD_BASE_REF;
  }
  if (env.FIREGUARD_TEST_COMMAND) {
    next.testCommand = env.FIREGUARD_TEST_COMMAND;
  }
  if (env.FIREGUARD_TEST_TIMEOUT_MS) {
    next.testTimeoutMs = Number(env.FIREGUARD_TEST_TIMEOUT_MS);
  }
  if (env.FIREGUARD_CONCURRENCY) {
    next.concurrency = Number(env.FIREGUARD_CONCURRENCY);
  }
  return next;
}

export function loadConfig(options: LoadConfigOptions): FireguardConfig {
  const configPath = options.configPath ?? '.fireguardrc.json';
  const absolute = resolve(options.cwd, configPath);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const env = options.env ?? process.env;

  let fromFile: DeepPartial<FireguardConfig> = {};
  try {
    fromFile = JSON.parse(readFile(absolute)) as DeepPartial<FireguardConfig>;
  } catch (error) {
    const err = error as { code?: string };
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }

  const config = applyEnvOverrides(mergeConfig(DEFAULT_CONFIG, fromFile), env);
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error(
      `concurrency must be a whole number of at least 1 (got ${String(config.concurrency)})`
    );
  }
  return config;
}
