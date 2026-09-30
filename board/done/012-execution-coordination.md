# EPIC: Execution coordination (milestone 4)

Runs, claims, readiness, worker submission, acceptance, failure/retry, host capability matching, epic feature-branch binding, and orchestrator/worker/reviewer skills. Demonstrates parallel independent work, blocked dependents, a join, competing claims, and stale-worker rejection.

Sub-tickets: 012.1–012.7.

## Acceptance criteria

- [x] All sub-tickets 012.1–012.7 are done
- [x] Lint, tests, fireguard, typecheck, deadcode, and build pass

## Verification — 2026-09-30

Every sub-ticket below was verified and checked off individually. Gate on commit `cf63a23`: `npm run lint` clean, `npm run typecheck` clean, `npm test` (2,932 app + 105 fireguard tests), `npm run deadcode` clean, `npm run build` ok. Fireguard graded the whole milestone diff against `main`: **A (score 100)**, AST 4,666 asserts / 0 mocks, flake 100/100, mutation 99% (1,908 of 1,923 killed). The 13 survivors that were real test gaps got tests in `c9b703e`; the other two were equivalent mutants, removed by simplification in `471b022`.

## Sub-tickets

### 012.1 — Runs, one active run per epic, branch binding

#### Acceptance criteria

- [x] Queue (desktop) and start (orchestrator) pin the current saved revision and activate sprint 1 (tested)
- [x] A second active run for the same epic is rejected (tested)
- [x] Start binds the epic feature branch (explicit or current checkout + HEAD) (tested)
- [x] Pause/resume/cancel follow the run state machine; cancel cancels open attempts (tested)

#### Verification — 2026-09-30

`src/core/services/runs.test.ts`.

### 012.2 — Server-side readiness

#### Acceptance criteria

- [x] Independent tickets are ready in parallel; dependents wait for accepted prerequisites; a join waits for all (tested)
- [x] Submitted-but-unaccepted prerequisites do not unlock dependents (tested)
- [x] Concurrency caps, retry limits, and expired leases appear as blockers (tested)
- [x] Tickets in later sprints are not claimable until the run advances (tested)

#### Verification — 2026-09-30

`src/core/plan/readiness.test.ts` and `services/execution.test.ts`.

### 012.3 — Claims, leases, submissions, acceptance, failure

#### Acceptance criteria

- [x] Competing claims for one ticket produce exactly one attempt (tested)
- [x] Heartbeats extend leases; expired leases require reconciliation before a new claim (tested)
- [x] Late writes from superseded or expired claims are rejected (tested)
- [x] Accept completes the ticket; reject/fail allow retries up to the limit; `onTicketFailure` policies apply (tested)
- [x] Idempotent retries of claim/submit/accept return the original result (tested)

#### Verification — 2026-09-30

`src/core/services/attempts.test.ts`, `attempts.review.test.ts` (incl. two connections to one file DB), the claim spike, and the lifecycle test (lease expiry → reconcile → stale token rejected).

### 012.4 — Host capability catalog

#### Acceptance criteria

- [x] The orchestrator registers the host's models/tools; claims record model id, host id, catalog revision, and rationale (tested)
- [x] A claim naming a model that fails hard constraints is rejected with `unsupported_capability` (tested)

#### Verification — 2026-09-30

`src/core/services/hosts.test.ts` and claim tests with catalogs.

### 012.5 — MCP execution tools and execution packet

#### Acceptance criteria

- [x] Execution tools (`start_run` … `cancel_run`, `register_host`, `match_capabilities`) map to the command layer (tested)
- [x] `claim_ticket` returns a bounded packet: pinned ticket, criteria, predecessor outputs, constraints, reporting contract (tested)

#### Verification — 2026-09-30

`src/mcp/tools/execution.test.ts`; packet contents in `attempts.test.ts`; exercised end to end by `npm run smoke:mcp`.

### 012.6 — Orchestrator, worker, and reviewer skills

#### Acceptance criteria

- [x] `skills/orchestrator.md`, `skills/worker.md`, `skills/reviewer.md` exist and are exposed as MCP prompts
- [x] Runs record the skill version (tested)

#### Verification — 2026-09-30

`skills/orchestrator.md`, `worker.md`, `reviewer.md`; `runs.test.ts` records `skillVersion` (default `SKILLS_VERSION`).

### 012.7 — Desktop run bar, execution overlay, attempts

#### Acceptance criteria

- [x] Run bar shows state, pinned revision, sprint k of n, counts, and pause/resume/cancel (tested)
- [x] Graph nodes show execution state (accepted, in review, running, ready, waiting, failed) with labels (tested)
- [x] Attempts strip and ticket attempts/evidence tabs show worker, model, lease, outputs, checks (tested)

#### Verification — 2026-09-30

`src/renderer/src/epic` view-model and component tests; the real app showed the run bar counts, execution states, and attempts strip updating from a separate MCP orchestrator process.
