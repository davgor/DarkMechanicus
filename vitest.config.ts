import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'

const define = {
  'import.meta.env.DEV': JSON.stringify(true),
  'import.meta.env.PROD': JSON.stringify(false)
}

/** What every test file runs with, in either group below. */
const shared = {
  environment: 'node' as const,
  // No test inherits the desktop app's naming pipe or a grant from the shell that runs it (src/test/hermeticEnv.ts).
  setupFiles: ['src/test/hermeticEnv.ts'],
  // On Windows, git without Git for Windows' launcher process in front of each call (see src/test/realGit.ts).
  globalSetup: ['src/test/realGit.ts'],
  testTimeout: 15_000,
  // A hook gets the same bound as the test it sets up: on a stalled Windows runner a one-second setup has run past
  // vitest's 10 s default.
  hookTimeout: 15_000
}

/**
 * The test files that start the most git processes: counted per file over a whole run, these start from about 60 to
 * almost 700 each (the rest start none or a few). Started together with everything else at full parallelism, the
 * slowest files first, they ran three to four times slower than alone, as each git process (about 26 ms to start on
 * Windows when the machine is quiet) waited on all the others, and some took their whole 15 s timeout. They run as a
 * group of their own after the other files, on half the CPUs. A new test file that starts dozens of git processes
 * belongs here.
 */
const GIT_HEAVY = [
  'src/core/workspace.forgeVerification.test.ts',
  'src/main/git/**/*.test.ts',
  'src/main/github/**/*.test.ts',
  'src/main/kanban/learningOperationRecord.test.ts',
  'src/main/kanban/approveLearningCard.test.ts',
  'src/main/kanban/learningWorkflow.test.ts',
  'src/core/services/learningLifecycle.test.ts',
  'src/main/desktop/forgeGit.test.ts',
  'src/main/desktop/forgeResolver.test.ts',
  'src/main/desktop/forgeService.setup.test.ts',
  'src/main/desktop/sourceCheckoutIpc.test.ts',
  'src/core/repo/git.test.ts',
  'src/core/repo/gitOriginConfig.test.ts',
  'src/core/services/attemptsIncrement.test.ts',
  'src/core/services/incrementVerify.test.ts',
  'src/core/workspace.gitFor.test.ts',
  'src/integration/incrementMerged.test.ts',
  'src/integration/multiRepo.test.ts',
  'src/integration/spaceCorrections.test.ts',
  'src/integration/spaceFailureMatrix.test.ts',
  'src/integration/spaceLoop.test.ts'
]

// Allow local verification to cap Git workers separately from the other Vitest projects.
const gitWorkers = Math.max(1, Math.min(
  Math.floor(availableParallelism() / 2),
  Number(process.env.DM_VITEST_GIT_MAX_WORKERS) || Infinity,
  Number(process.env.VITEST_MAX_WORKERS) || Infinity
))
// Forge bootstrap, conversion and provisioning rely on many real Git commands, including synchronous admission checks.
// Run them serially after the other Git suites to limit competing child-process launches.
const FORGE_RECOVERY = [
  'src/main/desktop/forgeBootstrap.test.ts',
  'src/main/desktop/forgeService.test.ts',
  'src/main/desktop/forgeProvisioningWork.test.ts',
  'src/main/desktop/forgeProvisioningAdmission.test.ts'
]

export default defineConfig({
  test: {
    projects: [
      {
        define,
        test: {
          ...shared,
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
          exclude: [...configDefaults.exclude, ...GIT_HEAVY, ...FORGE_RECOVERY]
        }
      },
      {
        define,
        test: {
          ...shared,
          name: 'git',
          include: GIT_HEAVY,
          maxWorkers: gitWorkers,
          sequence: { groupOrder: 1 }
        }
      },
      {
        define,
        test: {
          ...shared,
          name: 'forge-recovery',
          include: FORGE_RECOVERY,
          maxWorkers: 1,
          sequence: { groupOrder: 2 }
        }
      }
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__mocks__/**', 'out/**', 'src/test/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        lines: 97,
        branches: 95,
        functions: 96,
        statements: 97
      }
    }
  }
})
