import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from '../src/config.js';

describe('fireguard config', () => {
  it('exposes PRD defaults including 100 agentic flake runs', () => {
    expect(DEFAULT_CONFIG.thresholds.maxMockToAssertRatio).toBe(1.5);
    expect(DEFAULT_CONFIG.thresholds.maxTautologicalRatio).toBe(0.1);
    expect(DEFAULT_CONFIG.thresholds.minAssertionsPerFile).toBe(1);
    expect(DEFAULT_CONFIG.thresholds.minMutationScore).toBe(75);
    expect(DEFAULT_CONFIG.thresholds.flakinessRuns).toBe(3);
    expect(DEFAULT_CONFIG.thresholds.agenticFlakinessRuns).toBe(100);
    expect(DEFAULT_CONFIG.thresholds.maxFlakeRate).toBe(0);
    expect(DEFAULT_CONFIG.baseRef).toBe('main');
  });

  it('merges partial overrides without dropping defaults', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      thresholds: { minMutationScore: 80 },
      include: ['lib/**/*.test.ts'],
    });
    expect(merged.thresholds.minMutationScore).toBe(80);
    expect(merged.thresholds.maxMockToAssertRatio).toBe(1.5);
    expect(merged.include).toEqual(['lib/**/*.test.ts']);
    expect(merged.exclude).toEqual(DEFAULT_CONFIG.exclude);
  });

  it('loads JSON config from disk and applies env overrides', () => {
    const loaded = loadConfig({
      cwd: process.cwd(),
      readFile: () =>
        JSON.stringify({
          thresholds: { agenticFlakinessRuns: 50 },
          include: ['src/**/*.test.ts'],
        }),
      env: {
        FIREGUARD_MIN_MUTATION_SCORE: '90',
        FIREGUARD_BASE_REF: 'origin/main',
      },
      configPath: '.fireguardrc.json',
    });
    expect(loaded.thresholds.agenticFlakinessRuns).toBe(50);
    expect(loaded.thresholds.minMutationScore).toBe(90);
    expect(loaded.baseRef).toBe('origin/main');
    expect(loaded.include).toEqual(['src/**/*.test.ts']);
  });

  it('falls back to defaults when config file is missing', () => {
    const loaded = loadConfig({
      cwd: '/tmp',
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      env: {},
      configPath: '.fireguardrc.json',
    });
    expect(loaded.thresholds.agenticFlakinessRuns).toBe(100);
  });

  it('reads concurrency from the file and lets FIREGUARD_CONCURRENCY override it', () => {
    const fromFile = loadConfig({
      cwd: process.cwd(),
      readFile: () => JSON.stringify({ concurrency: 2 }),
      env: {},
    });
    expect(fromFile.concurrency).toBe(2);
    const fromEnv = loadConfig({
      cwd: process.cwd(),
      readFile: () => JSON.stringify({ concurrency: 2 }),
      env: { FIREGUARD_CONCURRENCY: '6' },
    });
    expect(fromEnv.concurrency).toBe(6);
  });

  it('rejects a concurrency that is not a whole number of at least 1', () => {
    for (const value of ['0', '-2', '1.5', 'many']) {
      expect(() =>
        loadConfig({ cwd: process.cwd(), readFile: () => '{}', env: { FIREGUARD_CONCURRENCY: value } })
      ).toThrow(/concurrency must be a whole number of at least 1/);
    }
    expect(() =>
      loadConfig({ cwd: process.cwd(), readFile: () => '{"concurrency": 0}', env: {} })
    ).toThrow(/concurrency must be a whole number of at least 1/);
  });
});
