# SPACE grading and measurement contract (policy `dm-space` v2)

Dark Mechanicus grades tickets, runs, sprints and epics on seven components with equal base weight. Five follow
the [SPACE framework](https://queue.acm.org/detail.cfm?id=3454124) (Satisfaction, Performance, Activity,
Collaboration, Efficiency); two measure resource economy (execution time and tokens).

**This is Dark Mechanicus's SPACE-informed policy, not an official SPACE formula.** SPACE supplies the
multidimensional framing. The normalization rules, weights and letter bands below are an explicit, versioned
product policy, not a validated scientific benchmark. Every grade names the policy and version it used.

| From the SPACE framework | Dark Mechanicus's own choice |
|--------------------------|------------------------------|
| Productivity has several dimensions (Satisfaction, Performance, Activity, Communication and collaboration, Efficiency and flow); no one metric stands for it | Which records stand for each dimension here: a person's 1–5 rating (S), reviewed verification less charged regressions (P), delivered over committed scope (A), handoff checks less coordination defects (C), corrective share of effort (E) |
| Measure several dimensions together, and mix perceptual and system data | One composite over seven components with equal base weights, letter bands, the F cap, the Ungraded and Provisional states, and the observation windows of experiments |
| Activity counts alone are not productivity | Activity volume, commits and changed lines are diagnostics, never scored |
| — | Execution time (T) and tokens (K), scored against frozen budgets or cohorts, are additions of this product, not SPACE dimensions |
| — | Every normalization rule, threshold, cohort size and anti-gaming limit below |

Read every grade as a Dark Mechanicus grade informed by SPACE, never as a SPACE score or a benchmark between teams.

| Piece | Where |
|-------|-------|
| Types (observations, baselines, policy, grade inputs, grades, evidence) | `src/shared/domain/space.ts` |
| Runtime validation of serialized records | `src/core/space/contract.ts` |
| Policies v1 and v2 (registered by content hash; `CURRENT_SPACE_POLICY` is v2) and the reference grader `gradeSpace` | `src/core/space/rubric.ts` |
| Baseline eligibility and selection | `src/core/space/baselines.ts` |
| Reference fixtures and worked examples | `src/core/space/fixtures/` |
| Time and effort projection (`projectTiming`, pure), its run feed (`projectRunTiming`) and its read command (`getRunTiming`) | `src/core/space/timing.ts`, `src/core/services/timing.ts`; types in `src/shared/domain/timing.ts` |
| S, A and C inputs from records (`getSpaceSignals`), desktop feedback (`recordHumanFeedback`), handoff checks | `src/core/services/spaceSignals.ts`, `src/core/services/humanFeedback.ts`, `src/core/space/handoff.ts`; types in `src/shared/domain/spaceSignals.ts` |
| P inputs: verification from review decisions and escaped defects (`getTicketPerformance`, `getEscapedDefects`) | `src/core/space/verification.ts`, `src/core/space/defects.ts`, `src/core/services/performance.ts`; types in `src/shared/domain/performance.ts`; fixtures in `src/core/space/fixtures/performance/` |
| E, T and K inputs: corrective share, resource actuals, budgets and cohorts (`getRunEfficiency`, `getTicketEfficiency`) | `src/core/space/efficiency.ts`, `src/core/services/efficiency.ts`; types in `src/shared/domain/efficiency.ts`; fixtures in `src/core/space/fixtures/efficiency/` |
| A ticket's grade from records (`getTicketGrade`: the three reads above at one cutoff, graded by `gradeSpace`) and run, sprint and epic grades (`getRunGrade`, `getSprintGrade`, `getEpicGrade`) | `src/core/services/spaceGrades.ts`; types in `src/shared/domain/spaceGrades.ts` |
| Scorecards frozen with report revisions (`getReportScorecard`) and dated reassessments (`reassessReportScorecard`) | `src/core/services/scorecards.ts`, `src/core/space/snapshot.ts` |
| Score read commands, the desktop's measurement controls (`recordHumanFeedback`, `recordEscapedDefects`, `setTicketBudget`) and the renderer's score reader | `src/core/commands/scores.ts`, `src/core/services/ticketBudgets.ts`, `src/renderer/src/scorecard/`; types in `src/shared/domain/scoreReads.ts` |
| The project metrics summary (`getMetricsSummary`: per-epic rows, totals, distribution, sprint trend, gaps, coverage) | `src/core/services/metricsSummary.ts`; types in `src/shared/domain/views.ts` |

## Measurement contract

Every value names its **unit**, its **scope** and its **source**, and is in exactly one **state**.

- **Units**: `tokens`, `milliseconds`, `minutes`, `count`, `rating_1_5`, `pass_fail`. Each metric has one fixed
  unit (`METRIC_DEFINITIONS`); a record whose unit disagrees is refused.
- **Scope**: `project`, `epic`, `sprint`, `run`, `ticket` or `attempt`, with every id the level needs (an attempt
  names its epic, run, ticket and attempt) and nothing more specific than the level.
- **Source**: `human` (a person in the desktop app), `server` (derived from Dark Mechanicus lifecycle records),
  `host` (agent-host adapter telemetry) or `agent` (self-reported over MCP). Each metric lists the sources allowed
  to record it. Only `human` may record satisfaction ratings, rescue time or planned review/playtesting time.
- **State**: `observed` (a number), `estimated` (a number with its method) or `missing` (a reason, no number:
  `not_reported`, `host_unavailable`, `partial_coverage`). Missing is never read as zero or as perfect. Numbers
  are finite, non-negative and at most 10¹⁵, so every ratio derived from them is finite.
- **Stable ids**: observations are `mo_…`, baselines `bl_…`, frozen grade snapshots `as_…` (`src/core/ids.ts`).
  Evidence references cite observations, baselines, attempts, runs, tickets, sprints, reports, comments,
  criteria (`ticket id` + `c1`), checks (`attempt id` + check name) or commits.
- **Times**: `observedAt` is the source's clock; `recordedAt`, baseline `frozenAt` and dispatch time are the
  server's. A grade uses only records stored by its `cutoff`.
- **Provenance** (absent, never null, when it does not apply, so older records keep their hash): `cause`, the
  known workflow cause of the work (`requirement`, `context`, `implementation`, `integration`, `tooling`,
  `verification`); `intervention`, a person stepping in (`rescue`, `clarification`, `override`, `retry_grant`,
  `redirect`), recorded only by `human` or `server` and required on `rescue_minutes` (a new rescue entry also
  requires its `cause`; older imported entries without one stay valid); and, on token and
  active-time metrics only, `usage` (`coverage` `self` or `inclusive` of every child session, and the
  `parentActor` it is nested in), so nested sessions are never summed twice.
- **Ledger**: observations are stored append-only by `src/core/services/observations.ts`; see
  [architecture.md](architecture.md#metric-observation-ledger).

### Direct measures and product proxies

| Metric | Unit | Signal | Sources | Feeds |
|--------|------|--------|---------|-------|
| `human_rating` | rating 1–5 | direct (stated satisfaction/confidence) | human | S |
| `verification` | pass/fail | direct (reviewer-checked result) | server | P |
| `escaped_defect` | count | direct (defect records: report, duplicate, reassessment, fix, withdrawal) | human, server, agent | P |
| `scope_committed`, `scope_delivered` | count | direct | server | A |
| `handoff_check` | pass/fail | **proxy** for collaboration quality | server | C |
| `coordination_defect` | count | **proxy** | server, human, agent | C |
| `corrective_effort_ms` | ms | **proxy** for flow (a classification of effort) | server, host, agent | E |
| `active_ms` | ms | direct | host, agent | T |
| `tokens_*` | tokens | direct | host, agent | K |
| `elapsed_ms`, `wait_ms` | ms | direct | server (+ host for waits) | diagnostic |
| `scope_added` | count | direct | server | diagnostic |
| `rescue_minutes` | minutes | direct | human | diagnostic |
| `human_review_minutes` | minutes | direct | human | diagnostic, never a rescue, never scored |
| `activity_volume` | count | **proxy** | server, host, agent | diagnostic, never scored |

S itself is a direct measure of what a person said, but only a proxy for satisfaction across everyone involved.
P, A and the resource components are direct measures of product outcomes; C and E are product proxies built from
Dark Mechanicus records. Worker claims are never verification, and satisfaction is never inferred from agent
prose.

### Host usage: tokens and active time at the boundary

Provider and host usage is normalized where it enters (`src/core/space/hostUsage.ts`), before anything is summed.

- **Categories keep their provider's definition.** `tokens_input`, `tokens_cached_input`, `tokens_output` and
  `tokens_reasoning` carry the provider's own numbers and say how they overlap: `includesCachedInput` on input,
  `subsetOf` (`tokens_input`, `tokens_output` or null) on cached input and reasoning, `includesReasoning` on output.
  OpenAI, Codex and Gemini count cached input inside input; Anthropic and OMP count cache reads (and writes, kept as
  `cacheWriteTokens`) apart from it. OpenAI and Codex count reasoning inside output; Gemini counts thoughts apart from
  the candidates; Anthropic and OMP count thinking inside output without reporting it, so `tokens_reasoning` is
  `missing` (`host_unavailable`), never 0.
- **One non-duplicated total.** `tokens_total` is the provider's own total when it reports one (`totalBasis`
  `reported`), else the sum of categories known to be disjoint (`derived_disjoint`). When an unknown top-level
  token field could be another category, no total is derived (`not_derivable`, missing `host_unavailable`).
  Graders read `tokens_total`; the categories explain it.
- **Unknown fields are kept.** Fields a format does not define are stored flattened as `raw.<path>` attributes of
  `tokens_total`, as far as the 20-attribute budget and the ledger's screens allow (`rawOmitted` counts the rest).
  A malformed count stays a raw field; it is never coerced into a category.
- **Cumulative and delta updates.** A provider's running totals (Codex `total_token_usage`) become per-update deltas
  first: a repeated total adds nothing, and a total that drops starts a new base. Claude Code writes one line per
  content block, each repeating its message's usage, so a message counts once by its id.
- **Nesting.** Each host thread reports its own usage (`self`) with the thread that started it as `parentActor`; a
  host that reports a parent inclusive of its children marks it `inclusive`, and the reads then skip the children.
- **Price is not cost.** A host's computed price is kept only as `listPriceUsd` with `costBasis: list_price` and the
  account's `billing` (`api_key`, `subscription`, `unknown`). No marginal cost is recorded: a subscription's usage
  costs nothing extra per token.

**Attribution** (`src/core/space/hostAttribution.ts`, run by `dm usage`): usage attaches through the session links
the host's own transcript holds (`hostTranscripts.ts`). The session must be linked to the run: a completed `start_run`
(by the run id in its answer), `takeover_run` or `claim_ticket` naming it. Its main thread is the run's
`orchestration` overhead within the run's window, from its first link to the run until its first link to a later run
(a session that cancels a run and starts another orchestrates each in turn, and each sample counts in one run). A
subagent thread works for the attempt whose claim token it was spawned with, then for each claim token handed to it in
a later message (a retry sent to the same worker) or presented in an attempt call the server answered (heartbeat,
submit, fail, record usage); tokens met in tool results never bind. A thread with no claim works for its parent's
attempt when it was started. A claim of another run's attempt by a thread started outside the run's window is left to
that run. A thread started in the run's window with no claim (a reviewer) or with a claim outside the run (a reviewer
quoting a token), and a claim of a carry-forward attempt (which ran nothing), go to the run's
`unattributed` overhead bucket: counted once in the run totals and shown per kind (`get_run_metrics`
`overheadByKind`). Each sample is decided only by what the transcript held up to it, so a later read never moves
usage already reported; rejected, failed, canceled and superseded attempts keep theirs. Active time is reported as
closed spans of request and tool activity (waiting tools and the person's turn excluded; a tool still running keeps
its span open), cut where the claim or the run window changes. A thread still working (a span open or less than 15
minutes quiet, or a message still being written) reports its tokens so far and then a `missing` (`partial_coverage`)
gap, so its cells read `partial` with the number as a lower bound and the run totals stay missing until a read after
it settles; the orchestrating session is always working while it runs `dm usage`, so the final read comes from
outside it. `start_run` links by the run id in its answer, `claim_ticket` and `takeover_run` by their arguments. Attributes
leave room for the two the server adds (`overhead`, `sourceEvent`), so many unknown fields never fail a report.
Which built-in agents can be read this way is `HOST_USAGE_SUPPORT` (`src/shared/domain/hostUsage.ts`); the others are
recorded unavailable (`dm usage --unavailable <host>`, which marks only buckets holding nothing and can be repeated)
unless a host relays real numbers over MCP. A provider's running totals are turned into deltas field by field for the
token categories only; other fields keep their latest value.

### Time and effort

`projectTiming` turns lifecycle events and host or agent activity spans into classified intervals; its
checked-in clock fixtures are `src/core/space/fixtures/timing/`. Every number is a `TimingQuantity` naming its
kind, unit (milliseconds), aggregation (`single`, `union` or `sum`), state, coverage and whether it is still open,
so no two of these can be mistaken for each other (each kind is also a distinct type):

| Quantity | Means | Coverage counts |
|----------|-------|-----------------|
| `attempt_elapsed` | claim to submit (or failure, cancel, lease deadline, run end, cutoff). Elapsed only | classified ms |
| `ticket_cycle_time` / `ticket_lead_time` | first claim / readiness to acceptance (or run end, cutoff) | classified ms |
| `measured_active` | the attempt worker's own activity spans inside the attempt | reporting attempts |
| `classified_wait`, `unclassified` | time per wait class; time nothing classified | classified ms |
| `resource_effort` | activity spans summed over every actor; overhead is everything but the worker | reporting attempts (overhead: reviewed attempts with an overhead span) |
| `in_flight_wall_clock`, `active_wall_clock` | union of attempt windows; union of activity spans | attempts |

- **Sources.** Elapsed time comes only from the server's records (attempt, run, report, approval and checkpoint
  rows; the local event log adds pauses, progress notes, retry grants and exact failure, cancel and takeover
  times). Active time comes only from `active_ms` spans: events, or deltas that state their `spanStart` (how host
  adapters report closed spans), from `spanStart` (else `observedAt` minus the value, truncated to whole
  milliseconds) to `observedAt`; a delta without a start is an amount with no place in time (`not_an_interval`).
  `wait_ms` spans with `waitKind` classify host waits. Server and human observations are not activity input.
- **Classes.** `active`, `queue` (ready and unclaimed, or awaiting reconciliation), `build_test`, `blocked` (run
  paused, or host-reported), `review` (submitted, undecided), `human_approval` (sprint checkpoint, retry grant,
  host-reported prompt) and `unknown`. Inside an attempt the worker's host-reported activity wins over a host wait,
  a host wait over the agent's self-reported activity and waits, those over a run pause, and everything else is
  `unknown`: after the last sign of life (`after_last_signal`), else `no_activity_evidence`. Each segment's
  `evidence` names the source that reported it (`host` or `agent`). There is no waste class: planned verification
  and research spans are active.
- **Missing stops.** An attempt with no end runs to the run's end, else to the cutoff (open); so does a pause with
  no resume. An expired lease ends the attempt at its deadline (or the takeover that expired it), also when the
  orchestrator later recovers its outputs (reconcile `resubmit`): the gap until then waits for reconciliation, and
  the recovered submission waits for review. `projectRunTiming` never projects past now (a later cutoff is clamped).
- **Bad input** is listed in `anomalies` and never guessed at: unparseable times, exact repeats, events out of
  place (a resume with no pause, a second submit), events of an unclaimed attempt, inverted spans, spans that
  disagree with their value by more than a second, cumulative values, unknown wait kinds, a re-delivered
  observation id (the first delivery wins), the part of an agent's report that overlaps anything the host reported
  with placed spans for the same work (an agent span, active or wait, counts only where the host reported nothing at
  all, neither activity nor a wait, and an agent report of such work that the projection cannot place is dropped
  rather than read as a gap: same identity, or, for work scoped to no attempt, where a role label may be missing, the
  same named actor), and anything that cannot be attributed to a sprint. Nothing is negative and nothing after the
  cutoff counts.
- **Effort.** Spans are grouped into streams by source, actor and `handle` attribute; without a handle a worker
  span belongs to its attempt and any other role (`role` attribute: `orchestrator`, `reviewer`, `other`) to that
  role across the run. A stream's overlapping spans count once; streams add up. A span reported `inclusive` of its
  descendants (usage `parentActor` chains) keeps only the time no descendant was active in effort, so each
  descendant keeps its own time and nothing counts twice; an inclusive worker's span still makes its attempt active
  over all of it, whatever scope its descendants reported under. Spans scoped to an attempt count from its claim to
  the end of its review or reconciliation; others within the run.
- **Retries.** Failed, rejected, canceled, expired and superseded attempts keep their elapsed time, effort and
  unknown time (`effortByOutcome`, with the attempts that reported nothing counted as `unreported`; spans scoped
  to no attempt are bucket `unscoped`; a span shared by attempts counts in one bucket, so the buckets add up to the
  effort total). A ticket carried forward from an earlier run accrues no time in this one.
- **Sprints.** One rule for every total (`membership: current_plan`): a ticket, with its attempts, segments and
  spans, belongs to the sprint holding it in the run's current plan; older revisions' sprint ids are mapped to the
  current plan's the way adoption maps the active sprint (same id, else same ordinal), so a rename loses nothing.
  Sprint and run waits are summed over tickets (ticket-milliseconds) plus the sprint checkpoint wait. Run-scoped
  overhead in no sprint is the run's `unattributedEffort`, shown beside each sprint (`unattributedOverhead`).
- **Missing is missing.** Nothing on record to measure (no activity, no attempt, no window) gives `missing` (null,
  nothing covered), never 0; some attempts unreported gives `partial` with the count in its coverage. An attempt
  with events but no claim on record counts, never covered, in the run's attempt coverage (wall clocks, attempt
  elapsed sum and effort read `partial`).
- **Scale.** Linear in records: spans are indexed by attempt and ticket once, inclusive and host covers are
  memoised, cuts are found by binary search and each classification is one sort and one pass. The 20,000-span
  shapes in `src/core/space/timing.test.ts` project to exact totals, and their interval work (the `IntervalWork`
  tally `projectTiming` takes as an optional second argument, counted operations, not time) for 20,000 records
  stays within 2.2 times that for 10,000.

### Efficiency, execution time and tokens (E, T and K inputs)

`getRunEfficiency` (`src/core/services/efficiency.ts`) builds a run's E, T and K inputs as of a cutoff (default now,
never later) per ticket, per sprint and for the run; `getTicketEfficiency` returns one ticket's. The rules are the
pure `runEfficiency` (`src/core/space/efficiency.ts`). Every scope uses the timing projection's membership: a ticket's
records are its attempts' and its own, a sprint's are its tickets' plus sprint-scoped overhead, the run's are all of
them plus run overhead; so review, orchestration and verification overhead is charged once, at the scope it was
recorded for (a ticket never carries the run's orchestration). Only the first delivery of each observation id is read
(a later one is listed as `duplicate_event` or `conflicting_delivery`), and only records stored by the cutoff. The
view's `anomalies` list the timing projection's anomalies and the read's own.

- **E's denominator is the observed effort** (`resource_effort`: every actor's activity in scope, summed, nested and
  duplicated reports once), shown with its coverage (attempts whose worker reported, of those that ran) and its
  overhead. `corrective_effort_ms` events classify parts of it with attribute `classification`: `corrective` (with
  its `cause`: requirement, context, implementation, integration, tooling, verification; `unstated` when none) or
  `productive` (attribute `work`, for example `research`, `planned_test`, `implementation`, `review`). Planned
  tests, review and useful investigation of a complex problem are productive. Unclassified effort is the observed
  effort minus the classified. Classified effort above the observed effort is listed (`over_classified`) and leaves
  E missing; a classification with no value leaves its class missing, never 0; an unknown classification is
  listed and counted as unclassified.
- **Retries are a diagnostic.** The retry count (attempts after each ticket's first) and each attempt's outcome and
  effort are shown beside E. A retried attempt's effort is classified like any other: a rejected attempt's research
  stays productive, and without classification records E is `zero_observation`, never a penalty for retrying.
- **T's actual** is the scope's observed effort (waits are not activity, so human-approval, retry-grant, checkpoint
  and queue waits are shown in `excludedWaitsMs` and never charged). **K's actual** is `tokens_total` of every
  executed attempt in scope (retried, rejected, failed, canceled and superseded ones included; carry-forward
  attempts ran nothing here) plus the scope's overhead records, read like `get_run_metrics` reads them.
- **Unknown stays unknown.** An attempt still open or awaiting review at the cutoff (the effort and usage can still
  grow), an `active_ms` record without a value, an `active_ms` record the timing projection refused or could not
  place (inconsistent with its value, inverted, an unparseable time, a delta without `spanStart`: `refused_span`),
  or a usage stream whose latest report is a `partial_coverage` gap (a host thread still working, so its open span is
  not reported yet) makes T, K and E's denominator missing (`partial_coverage`, or `host_unavailable` when every gap
  is a host that cannot report); an attempt that ran and reported nothing is counted for `partial_telemetry`; nothing
  measured is `not_reported`. A later settled read completes them.
- **Baselines.** A ticket compares with its budget version pinned to the revision it was first dispatched under
  (`getPlannedBaselines`), else with a cohort; every other budget version is listed, one saved at or after the
  dispatch as `frozen_after_dispatch`. Sprint and run inputs carry no baseline (`no_eligible_baseline`): their
  resource scores roll up from ticket measures (see [Run, sprint and epic grades](#run-sprint-and-epic-grades)).
- **Cohorts** are the work tickets of every run in the project with the subject's work type, size and planned
  reasoning level that were accepted, and still standing, before the subject's dispatch. Each is measured the same
  way as the subject, but only from records stored strictly before that dispatch (its run projected as of one
  millisecond earlier): records stored later (a late usage read, a rating, a supersession, the subject's own work)
  are ignored, never disqualifying, so the member set, values and baseline id are the same at every cutoff from the
  dispatch on. The subject itself, another key (`cohort_mismatch`), no size (`no_cohort_key`), an estimated, partial
  or unreported actual as of the dispatch (`not_observed`) and zero are listed as excluded. The cohort is the median
  with its sample size, p25/p75 and Tukey outliers (beyond 1.5 × the interquartile range, shown and kept in the
  median); `frozenAt` is its latest member record, and selection refuses it under 5 samples (`sample_too_small`).
  The samples read at the cutoff are reused when nothing feeding them changed at or after the dispatch; otherwise the
  run is projected once more per dispatch instant. Reading other runs never settles their leases.

### Verification and escaped defects (P inputs)

`getTicketPerformance` (`src/core/services/performance.ts`) builds a ticket's P input in one run as of a cutoff
(default now, never later), with the record it came from.

- **Independent review.** Only a review decision turns evidence into verification. Deciding needs
  `attempt.review`, which no worker holds. Every acceptance keeps the reviewer's own per-criterion results on the
  decision (`AttemptDecision.criteria`, `[]` when none were passed) as well as merging them into the evidence, so
  they stay distinguishable from the worker's claims. A sprint acceptance node's acceptance also freezes the
  Definition of Done it was accepted against (`AttemptDecision.requiredChecks`).
- **Items.** Every criterion of the plan revision the attempt ran under (cited as `criterion` ticket id + `c1`) and
  every reported check (cited as `check` attempt id + name) is an item with a basis: `reviewer_checked` (a criterion
  the reviewer stated; a check reported on an accepted attempt, since checks have no per-check review channel),
  `worker_claim` (only the worker said so; never verification, met or not), `review_unknown` (a criterion on an
  acceptance recorded before `decision.criteria` existed), `skipped` or `missing`. Criteria and the frozen Definition
  of Done checks are required; any other check is a diagnostic, shown and never a failure (a worker may report a
  failing suite it did not touch).
- **State.** The accepted, non-superseded attempt stands. It is `failed` (`confirmed_failure`) when a required
  reviewer-checked item failed (a Definition of Done check, a criterion the reviewer found unmet); `missing` when it
  was accepted before reviewer results were kept (`legacy_review_basis_unknown`: never read as reviewed, nor as worker
  claims), when a criterion rests on the worker's word or is unreported (`worker_claims_only`), or when a Definition
  of Done check was skipped or not reported (`required_evidence_missing`); otherwise `verified` (`reviewed`). Without
  an accepted attempt the outcome is `pending` (`awaiting_review`, `in_progress`, or `awaiting_retry` after a
  rejection, failure or abandoned lease with tries left), `failed` once the ticket had used every try (failed and
  rejected attempts and reconciled expired leases against the revision's retry limit plus the grants made by then),
  or `missing` (`run_ended`) once its run ended without an outcome for it. Retry grants are machine-local (the tracked
  run record never carries them), so using every try is confirmed only where the grants are taken as known: on the
  machine that owns the run (the closest signal: a taken-over run's earlier grants stay on the machine that made
  them), or once the run ended `failed` under `onTicketFailure: fail_run` on that very ticket (pause reason
  `ticket_failed:<key>`), which its owner does only after its readiness, grants included, found the ticket out of
  tries; an ended run takes no grant. A `pause_run` pause keeps that reason after a later grant and confirms nothing.
  Read anywhere else (a run that arrived through Git, such as a folder with records from before scorecards), a ticket
  out of tries by its records is `missing` (`retry_grants_unknown`), insufficient evidence and never a confirmed
  failure; it still counts, leaving the aggregate's verification missing. A carried-forward ticket
  (`carried_forward`) and a ticket never dispatched (`no_attempt`) are `missing`.
- **Same cutoff, same input.** The cutoff rewinds each attempt using only times written once: decision, submission,
  supersede and reconcile columns; failure, cancel and takeover times from the event log (a cancel falls back to the
  run's end, a lease expiry is its deadline: a held attempt whose deadline passed by the cutoff reads expired whether
  or not a read has settled its lease yet); retry grants by their logged time; and the Definition of Done frozen on
  the decision. Nothing current (the project's Definition of Done, the execution state, `updated_at`) is read. Limits:
  a failure recorded on another machine has no local log entry and is timed by its row's last update; records
  imported later keep their own server times, so they can join an earlier cutoff; and a ticket out of tries reads
  `failed` or `retry_grants_unknown` depending on whether the reading machine owns the run (above), so two machines
  can read the same records differently. A consumer that must keep an input exactly (a frozen report snapshot)
  stores it.
- **Escaped defects** are `escaped_defect` observations in the ledger, each of an epic and naming its
  `defectEvent`. A `report` (value 1) names `severity` (critical, high, medium, low), `attribution` (`attributed`,
  `candidate`, `unassigned`), `discoveryPhase` (`integration`, `sprint_acceptance`, `sprint_review`, `later_sprint`,
  `after_epic`), optionally a `defectKey` (an external issue key), exactly one commit with evidence detail
  `source build`, and an origin that fits the attribution: attributed names the origin ticket and its accepted work
  attempt (detail `origin`; the server refuses any other attempt), a candidate names the ticket, unassigned names
  nothing. Later records (value 0) cite a report with detail `defect`: `duplicate` (with detail `duplicate` on the
  other report), `reassessment` (a new severity and/or attribution with its origin), `fix` (detail `fixed by` on a
  commit, ticket or attempt) and `withdrawal`. The ledger refuses anything else, on record and on import
  (`defectProblem`, `src/core/space/defects.ts`).
- **Who may change charging.** An attributed report, a duplicate, a reassessment, a fix and a withdrawal change what
  is charged, so they come from a person (`human`), the server, or an agent session holding `attempt.review` (an
  orchestrator or reviewer), which the server stamps (`authority: review`; a caller-set stamp is refused). A worker
  sending one through `record_attempt_metrics` is `unauthorized`; an unstamped agent or host record is refused by the
  ledger and ignored by the read model. Any reporter may add a candidate or unassigned report, which charges no one.
- **Reading defects** (`getEscapedDefects`, `resolveDefects`): only records stored by the cutoff count. A defect's
  id is its first report's. Under one defect key in an epic, a report folds into the first group of that key whose
  judgement (severity, attribution, origin) it shares, however many disagreeing reports came between; one that agrees
  with no group starts its own defect and is listed as `conflicting_reports` until a person reassesses or joins them.
  A duplicate record joins the two reports it names, and the joined defect reads what the cited `defect` report's
  group reads, so the record decides which report is the defect. Folded reports count once. Records link by
  reference, so a report and its withdrawal in one call read correctly whatever their ids; reassessments apply in
  ledger order (`recordedAt`, then id: a call's server ids follow call order). A withdrawal withdraws only the report
  it cites: the defect reads its base report while that is not withdrawn, else its earliest one that is not and shares
  the base's severity, attribution and origin, else its earliest one that is not, and counts while one remains. A fix
  keeps it counted (it escaped) with status `fixed`. Nothing is deleted or rewritten.
  Records citing no known report, second withdrawals and conflicting reports are listed as anomalies.
- **Charging.** A ticket's regressions are the counted defects whose origin is the ticket. Only an `attributed` one
  that names the standing accepted attempt and was stored (server `recordedAt`, never the caller's `observedAt`) after
  its decision is charged (`attributed` in the grade input); a candidate, another outcome's or one stored before the
  acceptance is passed as `unassigned`, shown and never charged. A later confirmed regression therefore changes only
  inputs built for a later cutoff (`basisAt` is the latest record used): earlier inputs, the accepted attempt,
  reports and run history stay as they were.

## Who records, checks and reviews

The server computes every grade; no role states one, and no grade a role writes is ever read. Each role adds only the
records it is in a position to know, and the server refuses the rest. The role guides (`skills/`) give each role its
part; this is the whole picture.

| Who | Records | Checks and reviews | Never |
|-----|---------|--------------------|-------|
| Person (desktop) | Satisfaction ratings, rescue minutes (with intervention and cause), planned review or playtesting minutes (each at least 1 and at most 2,400 minutes when given; omitted is missing, never 0), budgets labelled as a person's estimate. Escaped defects: the `recordEscapedDefects` command accepts a person's records (source `human`), but no desktop control calls it yet, so today a person asks the orchestrator to record them | Reads the Scorecard and Improvement tabs and the Metrics dashboard; saves plans, adopts revisions, approves checkpoints; routes corrective work aimed at the Dark Mechanicus source and brings its grades back | — |
| Planner | Budgets with basis `planner_estimate` or `prior_tickets`, sizes and reasoning levels (the cohort keys), corrective DRAFT work (`create_corrections`) | Validates the draft | Introduces the person's-estimate label or changes amounts under it (it may replace or clear such a budget, visibly in the plan diff); saves without `--allow-save`; approves |
| Worker | Its own attempt's usage with its claim token when its host is not read, corrective or productive classification of its effort, candidate or unassigned escaped defects | Reports each criterion and check with a note; its evidence is a claim | Human metrics, verification, handoff checks, attributed defects, grades |
| Reviewer | Review overhead usage (`record_run_metrics`) | Per-criterion results on `accept_attempt`, the only source of verification; reads grades with the read tools | Accepts its own work or on a worker's claim; regrades |
| Orchestrator | Usage of the run (`dm usage` after each row, or relayed numbers, or marked unavailable), overhead, attributed escaped defects (stamped `authority: review`), experiment statuses and results (`record_experiment_event`), report revisions (which freeze scorecards), corrective DRAFT work | Accepts or rejects with per-criterion results; reads grades | Approves checkpoints, saves without `--allow-save`, starts corrective work in another project, accepts its own work |
| Sprint reporter | The retro and its experiments, drawn from `get_retro_findings` | Quotes the frozen scorecard (`get_report_scorecard`) | Writes a grade, infers satisfaction from prose, states a cause the metrics cannot prove |
| Server | Verification from review decisions, handoff checks, committed and delivered scope, elapsed time and waits, dispatch and freeze times, baselines pinned at dispatch, grades, frozen scorecards, findings | Every refusal above | Imputes a missing measure |

**Evidence hierarchy.** When records disagree or overlap, the stronger source decides:

1. **Review decisions and server lifecycle records** (`server`). Verification, scope, handoff checks, elapsed time, waits
   and dispatch times. A worker's claim is never verification.
2. **A person's records** (`human`), entered in the desktop app: satisfaction, rescue and review time, a person's
   estimate. No agent may record them. (A person's escaped-defect records have a command but no desktop control yet.)
3. **Host telemetry** (`host`): the host's own session records read at the boundary. When the host and an agent report
   the same delivery, the host's report counts and the agent's is ignored; an agent's activity span counts only where the
   host reported nothing.
4. **Agent self-reports** (`agent`), over MCP: counted where nothing stronger exists, never as verification.
5. **Estimated** values (with their method): the component is estimated and the grade provisional.
6. **Missing**: no number, a reason, never 0 and never imputed. A component without a score drops out of the weights
   and the coverage shows it.

**Which integrations emit usage** (`HOST_USAGE_SUPPORT`, `src/shared/domain/hostUsage.ts`):

| Agent or host | Tokens and active time |
|---------------|------------------------|
| OMP (in-app or as the orchestrating host) | Read from its session files by `dm usage` (tokens per request; request and tool spans) |
| Claude Code (in-app or as the orchestrating host) | Read from its session JSONL and subagent files by `dm usage` (message usage and line times) |
| Codex (in-app) | Unavailable: the chat does not know its rollout file. Only numbers an orchestrator relays over MCP count |
| Cursor Agent | Unavailable: it writes no token usage |
| Autonomous | Unavailable: it exposes no usage |
| Custom agents and other MCP hosts | Unavailable unless the host relays real numbers with `record_attempt_metrics` / `record_run_metrics` |

Even a supported host leaves gaps that stay visible: Anthropic and OMP report no reasoning-token count (`tokens_reasoning`
is missing, never 0), a thread still working reads `partial` until it settles, a session not linked to the run is not
attributed, and no marginal cost is recorded (only a list price, with the account's billing). An unsupported host's
usage is recorded unavailable (`dm usage --unavailable <host>`), so T and K read missing (`host_unavailable`) rather
than perfect. Nothing promises telemetry a host does not write.

**Overhead attribution.** Orchestration, review and verification usage goes to the run's overhead buckets (or one
sprint's), never to a worker's attempt; usage the host read but could not tie to one attempt is `unattributed` overhead,
counted once in run totals (see [Attribution](#host-usage-tokens-and-active-time-at-the-boundary)). Aggregate T and K
include overhead; ticket T and K do not carry the run's orchestration.

**Baseline pinning.** A ticket is compared with the budget version of the revision it was first dispatched under, frozen
strictly before that dispatch, else with a cohort frozen from earlier accepted tickets (see [Baselines](#baselines)).

**Report immutability.** A report revision's scorecard is frozen at submission and never regraded in place; later
records appear only in a dated reassessment (see [Scorecards and reassessments](#scorecards-and-reassessments)).

## Components and normalization (0–100)

Each component is scored by one named rule. Scores are clamped to 0–100.

| | Component | Required | Rule | Score |
|-|-----------|----------|------|-------|
| S | Satisfaction | no | `S.rating.v1` | `(rating − 1) × 25`: 1→0, 2→25, 3→50, 4→75, 5→100 |
| P | Performance | yes | `P.verified-less-regressions.v1` | verified: `100 − Σ penalty` over attributed regressions (critical 50, high 30, medium 15, low 5); confirmed failure: 0 and the F cap |
| A | Activity: delivery against committed scope | yes | `A.delivered-over-committed.v1` | `100 × delivered ÷ committed` |
| C | Collaboration | yes | `C.handoff-pass-rate.v2` (v1: `C.handoff-pass-rate.v1`) | `100 × passed ÷ (passed + failed) − 10 × coordination defects`; v2 counts every check of a submission the review rejected as failed |
| E | Efficiency and flow | yes | `E.corrective-share.v1` | `100 − 150 × corrective ÷ (corrective + productive)` |
| T | Execution-time efficiency | yes | `T.baseline-ratio.v1` | `150 − 50 × actual ÷ baseline` (≤ 1× → 100, 1.2× → 90, 2× → 50, ≥ 3× → 0) |
| K | Token efficiency | yes | `K.baseline-ratio.v1` | as T, on tokens |

When each component is missing:

- **S**: a ticket uses its own rating. Without one it inherits a sprint rating only when the person chose to
  share that rating with the sprint's tickets; the component is then marked `inherited`. A sprint grade uses the
  sprint's own rating directly. Run and epic grades have no rating of their own in v1: a shared sprint rating
  counts there only as inherited context, an unshared one not at all (`getSpaceSignals` reads the subject's only
  sprint, none when it has several). Otherwise `no_rating`. A ticket rating is refused on any input that is not
  ticket-level. Ratings come only from a person in the desktop app; the latest per scope counts and a ticket
  inherits from the sprint that held it at its first dispatch. **S is optional** (an owner decision): its absence
  never blocks a final grade, but its weight drops out (the other six then weigh 1/6 each) and coverage shows it.
- **P**: verification `pending` → `verification_pending`; `missing` (no reviewed evidence, or required evidence
  missing) → `verification_missing`. Unassigned regressions are shown, never charged. Regressions are those known at the
  cutoff; a later one produces a dated reassessment, not a rewrite.
- **A**: no frozen pre-dispatch scope → `scope_not_frozen`; zero committed → `zero_scope` (never 100). The scope is
  frozen from the saved revision the subject's first claim ran under (a ticket's with its sprint's): a ticket commits
  its acceptance criteria (id and text, compared ignoring case and runs of whitespace: a casing or spacing edit is the
  same criterion, rewording one is new scope), a sprint, run or epic its work tickets by id
  (acceptance nodes, optional tickets and tickets carried forward before the first claim are not outcomes of this
  scope). A committed ticket is delivered only when its acceptance verified every criterion it held when frozen.
  Removed committed items stay in the denominator, so splitting, trimming, renaming or deleting work cannot raise A.
  Added scope, attempts, commits and changed lines are diagnostics: activity volume is never rewarded. Every
  undelivered committed item says why: `not_accepted`, or `criteria_unverified` naming each criterion the acceptance
  did not verify (`not_met`, or `changed` when the accepted revision holds no such criterion).
- **C**: a submission whose derived checks are unavailable → `not_reported`; no submission → `no_handoffs`. The
  server derives three checks from each submission as it arrives (`criteria_evidence`, `verification_checks`,
  `outputs_contract`), from what was handed off only, never from the review; when the ledger refuses them the
  submission still goes on, unchecked. A criterion reported unmet with a note has its evidence, so purposeful
  clarification is not a failure, and it is never a coordination defect; a defect must cite a run record.
- **E**: any effort measure missing → that reason; nothing classified → `zero_observation`; less than 80% of
  effort classified → `insufficient_classification`. Planned tests and useful investigation are productive.
  Retries are a diagnostic, never labeled wasted time. E measures the corrective share, not absolute time or
  tokens, so a costly ticket is not charged twice.
- **T, K**: actual missing → its reason; any attempt that ran without reporting → `partial_telemetry`; actual
  zero → `zero_observation` (never an automatic A); no baseline that passes every baseline check →
  `no_eligible_baseline`, with the refused baseline id and reason in the diagnostics. The actual includes
  review, orchestration and verification overhead and every retried, rejected, failed, canceled and superseded
  attempt; carried-forward work is not counted twice; human-approval and queue waits are not active time.

An `estimated` input yields an `estimated` component, which keeps the grade from being final.

## Weights, precision and bands

- **Base weights**: every component has integer weight 1, so each starts at **1/7**.
- **Effective weights**: a scored component's weight over the sum of scored weights; a missing component's is 0.
  Missing components are excluded, never imputed. **Coverage** is the share of base weight scored.
- **Precision**: component scores and the composite are kept as integers in units of 10⁻⁶ (6 decimals, round
  half up). The composite is `round(Σ wᵢ·unitsᵢ ÷ Σ wᵢ)` over scored components. Letters compare that canonical
  value, before any display rounding.
- **Bands**: **A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.** 89.999999 is B; 90 is A.
- **Display**: one decimal, **rounded down**, so a shown score never reads as a higher band than its letter
  (89.99 shows as 89.9 B, never 90.0). Display precision never exceeds canonical precision.
- **Helpers**: `letterFor(score)` and `displayScore(score)` take a score in **points** (0–100), as
  `SpaceGrade.score` holds it, and refuse anything else (`letterFor(95)` is A; `letterFor(90000000)` throws).

## Status and outcome

`outcome` is `verified`, `failed` or `unverified` (pending or missing verification). Rules, in order:

1. **Confirmed mandatory failure caps F.** A confirmed failed mandatory check or criterion sets P to 0, adds a
   `mandatory_failure` cap and letters the grade F with its score capped at **59**, however fast or cheap the
   work was: the cap is independent of the weights, so no score on the other six components can lift it. The uncapped
   score stays visible.
2. **Missing required verification yields Ungraded.** With verification pending or missing there is no score
   and no letter, whatever the other components say.
3. **Too sparse yields Ungraded.** A verified subject with fewer than **4** scored components is ungraded
   (`insufficient_coverage`).
4. **Incomplete yields Provisional.** A score and letter labeled provisional when a required component is
   missing (`required_component_missing`) or any component is estimated (`estimated_input`).
5. Otherwise **Final**.

A failed outcome is final when every required component is observed and provisional otherwise; its letter is F
either way. Every grade shows all seven components with their inputs, rule, evidence, missing reason, base and
effective weight, plus coverage, caps, the policy version, cutoff, dispatch time and the ids of the baselines it
actually used.

**Explanations.** Each component carries an `explanation`: its rule written out with this grade's numbers and its
result (or why the rule gave no score), the cutoff its records were read at, for T and K the baseline it was offered
(id, kind, value, version, `frozenAt`, cohort sample size, and the grader's `refusedReason` when it refused it), and
the caps it triggers (P: `mandatory_failure`). The grade's `explanation` gives the composite with its terms
(`(S 75 + P 95 + …) ÷ 7 = 85.357143`), the cap (`min(79.166667, 59) = 59`), how the letter was reached
(`85.357143 ≥ 80 → B`), what the status means and why, the missing components with their reasons, the rounding
(canonical decimals, half up; display decimals, floor) and every record cited, once each.

**Reproducibility.** A grade names its input by content hash (`inputHash`: sha256 over the validated input's
canonical JSON) and its policy by id, version and content hash (`policy.hash`), so the same input and policy give
the same grade byte for byte, and a reused version number with changed content is visible. `getTicketGrade` reads
its three sources at one cutoff in one transaction; records stored after the cutoff never change the grade at that
cutoff. No grade a worker states is ever an input: only the seven component inputs are (an unknown input field is
refused).

`gradeSpace` validates its input and policy first and refuses malformed ones (`invalid_input`), so every grade
it returns parses as a `SpaceGrade`. The grade schema also refuses internally inconsistent records: score,
uncapped score, display score and letter are null exactly when ungraded; the capped score never exceeds the
uncapped one; status reasons are distinct, in contract order and agree with the outcome, caps, components and
status; the explanations agree with the grade (composite and letter text null exactly when ungraded, a cap text
exactly when a failed outcome is scored, the missing list matching the missing components, every component naming
the grade's cutoff, only P carrying the cap); the subject id has its level's prefix (`tk_`, `rn_`, `sp_`, `ep_`).

## Run, sprint and epic grades

An aggregate grade is `gradeSpace` on the scope's own raw measures, never an average of ticket letters or scores.

- **Roles.** Each ticket's role is frozen with the plan revision of its first dispatch in the epic: an acceptance
  node or a ticket tagged `administrative`, `fireguard` or `overhead` is **overhead** (integrated: its outcome counts
  in P, its cost in T and K, never as a delivered feature in A); an `optional` ticket is shown and never required;
  any other is a feature ticket. A later adoption cannot make a failed required ticket optional.
- **P.** A confirmed failure of any counted outcome (an integrated one, or a required feature ticket) fails P and caps
  the grade at F. In an epic a ticket counts once, from the last run with an own outcome: a run that ended (or has not
  dispatched it) without an attempt of it, or a carried-forward record, never supersedes an earlier failure. A sprint
  keeps the outcome a ticket had while it held it, even after an adoption moved it elsewhere (`movedOut`).
- **E, T and K** come from the scope's efficiency, overhead included, in the runs that executed work; a run that
  executed nothing adds no measures. T and K compare with the **roll-up**: the baselines the scope's own ticket grades
  accepted, each ticket once per scope (its first run's), so restarting a run never buys a fresh allowance. An
  executed feature ticket without a baseline makes the roll-up **partial**: the actual leaves that ticket's own cost
  out, is marked estimated, and the grade is provisional, with the uncovered tickets listed; the grader refuses a
  partial roll-up against an observed actual (`incomplete_rollup`) and refuses a budget or cohort at aggregate level,
  or a roll-up at ticket level (`level_mismatch`). Sprint totals follow the current plan, so a ticket an adoption
  moved into a later sprint after it ran in an earlier one brings every attempt's cost there; that sprint's measured
  window (its grade's `dispatchedAt`) starts at the moved ticket's first dispatch, and its budget is compared with
  that cost instead of being refused as dispatched before the sprint (`invalid_time`).
- **C (policy v2).** A submission the review rejected counts every check it passed as failed, so another rejected
  attempt never raises C or the grade. The grade input carries the raw tally and `rejected`; the policy's C rule id
  decides what it means, so a v1 grade regrades the same under v1.

## Scorecards and reassessments

Submitting a sprint report revision freezes its **scorecard**: the sprint, run and (final sprint) epic grades and
every ticket grade of the sprint at the submission's server time, with the policy (by content hash), the plan
revision, the report's content hash, every grade's inputs (baselines included), the timing and efficiency inputs as
they stood, and the source ids. It is stored with the revision (`sprint_reports.scorecard_json`, schema v16; null for
earlier reports, which stay ungraded) and exported as its own record, `history/<runId>/scorecards/<reportId>.json`,
which the run history names by id and seal. It keeps inputs (pooled by content hash, so identical aggregates such as
the run and epic of a single-run epic are stored once) and compact results, not explanations: a read regrades every
stored input under the stored policy and requires the stored result back. Its recorded parts must agree with those
inputs: the ticket list is the sprint's tickets, the counted outcomes are the ones each aggregate's P input cites, the
efficiency and timing totals are the grades' actuals, and the source ids hold every attempt and ticket the outcomes
name. An import refuses a scorecard that fails any of this, or whose seal, run, epic, sprint, report revision (id,
number, content hash), plan revision or graded subjects do not match the run history that names it, and a run history
naming another scorecard for a report that already has one. Export checks both sides as for other immutable records:
a scorecard file already there must hold the same snapshot, and one written must pass the import's checks; otherwise
the run's export fails with `conflict`. One golden scorecard per policy (`src/core/space/fixtures/snapshots/`) must
keep reproducing byte for byte. A changed report is a new revision with its own scorecard; the existing
stale-approval rules apply.

A **reassessment** (`reassessReportScorecard`) returns the approved snapshot untouched and regrades each subject at
the approved cutoff and at its own; every changed component names its cause (`policy_changed`,
`records_at_cutoff_changed`, `later_records`, `window_start_moved`) with the comparable windows, and every subject its
membership: `kept`, `left` (frozen, since moved out of the sprint: shown, never dropped), `joined` or `legacy`.

## Reading scorecards and the desktop's measurement controls

Every scorecard read is a command over one core read model, returned unchanged (`src/core/commands/scores.ts`, types
in `src/shared/domain/scoreReads.ts`); nothing outside the core grades or regrades. The reads (capability `read`):
`getTicketGrade`, `getSprintGrade`, `getRunGrade`, `getEpicGrade`, `getReportScorecard`, `reassessReportScorecard`,
`getSpaceSignals`, `getTicketPerformance`, `getEscapedDefects`, `getRunEfficiency` and `getRunTiming` (the run's
`projectRunTiming` as of a clamped `cutoff`, unchanged; `ticketId` keeps only that ticket's entry, `not_found` when the
run holds no such ticket), beside `getRunMetrics` and `getPlannedBaselines`. The desktop calls them through its command
channel (`DESKTOP_COMMANDS`), and every MCP session (any role) through the read-only tools of `src/mcp/tools/metrics.ts`
(`get_ticket_grade`, … `get_run_timing`, `get_metrics_summary`), which return the same JSON. `getReportScorecard` is pinned to one report revision (`reportId`, and optionally the `reportRevision` the view
expects; any other is `not_found`) and answers `{ state: 'frozen', report, scorecard }` with the snapshot frozen with
it, or `{ state: 'legacy', report, reason }` for a report from before scorecards: never a live grade and never an empty
one. Missing telemetry stays missing in the grade itself (`ungraded` or `provisional`, each missing component with its
reason and a null score). Unknown ids are `not_found`; a read names its workspace by folder, so another project's ids
name nothing.

The renderer follows a scorecard with `createScoreReader` (`src/renderer/src/scorecard/scoreReads.ts`, React:
`useScoreRead`): typed `idle`, `loading`, `ready` (with the last refresh's error beside the data it kept) and `error`
states, each error with an action (`retry`, `reload`, `not_permitted`, `not_found`, `fix_input`). A new identity (run,
ticket, report revision) starts over and drops any late answer for the previous one (`useScoreRead` returns `loading`
in the render that changes the identity, never the previous identity's data); refreshes (an event, a poll, focus) never
stack, and one asked while a read is in flight runs once that read settles, so a write's refresh is never lost. A
person's open edit lives in an `EditBuffer` (`edit: { value }`, so a clearing `null` is an edit too): a refresh moves
the saved value under it, never overwrites it, and flags a change made meanwhile.

The epic workspace's **Scorecard** view (the header's View group: Graph, List, Scorecard; `src/renderer/src/epic/EpicScorecard.tsx`)
reads the composed `epicCard` identity (`loadEpicCard`). An open epic shows its live `getEpicGrade` and every run it
covers at that grade's cutoff: each sprint's frozen report grade when the sprint has a report, else its live
`getSprintGrade`, the run's `getRunTiming`, and for a run the grade did not measure (it executed no work but may have
recorded overhead) its own `getRunEfficiency` run scope. A completed epic shows its immutable assessment, the epic grade
frozen with its latest run's final sprint report (`legacy` and ungraded for a report from before scorecards), and
nothing live stands in: its sprints show frozen report grades only, each run's timing is the one frozen with that run's
last report (a run that never reported counts with its own server lifecycle window, immutable once it ended), and it is
not polled (its freshness line says so). An epic never saved reads nothing and says so. Beside the grade it shows the
original scope and outcomes (why accepted tickets alone do not make the epic a success), a per-sprint drill-down, total
resources over every covered run (every attempt and overhead; a run without a number is named and the total reads as a
lower bound; wall time is the union of run windows, never a sum of parallel time, and reads "as of" the final report or
the read while a window was still open), the failure causes that weigh most, and comparisons only between compatible
readings: T and K against a complete, accepted roll-up, and the frozen epic grade against the core's reassessment over
comparable windows under one policy.

**Sprint-report Scorecard tab.** Every sprint report, in the checkpoint review and in a completed epic's history, has
Report and Scorecard tabs (`src/renderer/src/checkpoint/ReportTabs.tsx`, `ReportScorecard.tsx`). The Scorecard reads
the report revision it shows (`reportCard` identity: `getReportScorecard` pinned by `reportRevision`) and says what that
snapshot is: awaiting approval, approved at this checkpoint, or historical; a legacy report reads ungraded. Before a
sprint has a report, the tab is its live grade (`getSprintGrade` now, with `getRunTiming` at that grade's cutoff),
labelled live and provisional (only the live view is polled). The tab shows the grade and how it follows, the sprint
outcome, the seven components, tokens, time and overhead, measurement coverage, failure causes and each ticket's frozen
grade. A T or K total with attempts that reported nothing reads as a lower bound (`≥`, naming how many), a roll-up with
no baseline reads "no eligible baseline", and a frozen interval still open at the report reads as of the report. A
reassessment is read only on request (`reassessReportScorecard` without a cutoff, so the server dates it), shown apart
with its date, policy and provenance and the cause of each difference; it never replaces the snapshot, so late metrics,
ratings, defects and a newer rubric show up there only.

**Sprint-report Improvement tab.** A report that was measured or carries a retro also has an Improvement tab
(`src/renderer/src/checkpoint/ReportImprovement.tsx`, view model `improvementView.ts`), the same in the checkpoint review
and a completed epic's history. It reads the retro as one chain: the measured result (the sprint grade frozen with the
revision), the findings read from that scorecard (`getRetroFindings`, each with magnitude, coverage, hypotheses labeled
as such, the proposal outline or why it is withheld, and its evidence links), the experiments drawn from them (linked
both ways by the cited assessment and measure; standing and outcome from `getExperiment`), and the corrective work they
led to (tickets found by correction marker, saved or still in a draft, and any follow-up epic holding them). Findings and
experiments are read when the tab opens and when the workspace reloads, never polled; an unreadable part says why and
offers Try again beside the rest. The Report tab lists the experiments in brief and points here.

Below the chain, the corrective planner (`CorrectivePlanner.tsx`) lets the person select experiments, see the
destination (this project's repository, per experiment; an experiment aimed at the Dark Mechanicus source is routed by
its own panel, below, `correctionRoute.ts`), pick a new or existing later sprint of the draft (a
follow-up epic for a completed epic), keep or drop the Fireguard ticket, edit each work item of the selected
experiments (title, body, criteria and prerequisites, under Selected work, with or without a preview, so an edit that
blocks its experiment can always be fixed or reset), and preview the tickets, criteria and covers, dependencies,
destination and the draft's validation (`previewCorrections`). Create draft work (`createCorrections`, with the
`expectedDraftRevision` the preview read, null when it found no draft, so a draft opened since is refused as stale) is
offered only for a current preview with nothing conflicting or blocked; it writes DRAFT work and leads to the draft's
normal Save, adopt and run controls (or the follow-up epic). Opening a report or a low grade starts nothing, and
nothing here saves, adopts, starts or approves. Selections and edits are kept for the session per sprint of a run
(`plannerStore.ts`): tab switches, reloads, a newer report revision and refusals (a changed draft, a replaced report,
an experiment created differently, blocked work with its restatement, an invalid prerequisite, a completed epic) keep
them, and each refusal says what recovers it. Each request leaves out, and says so, what no longer fits: a selected
experiment that cannot be selected now (withdrawn, finished, aimed at Dark Mechanicus, or its standing unreadable; its
box stays ticked and operable so it can be cleared), a kept sprint target the epic no longer has (or a completed epic),
and an edit of a work item a newer revision no longer has. An edit records the revision and the work item it was
written against; when a newer revision restates that item, the edit is held until the person keeps or discards it.
The result of a creation is shown only for its report revision and, in this epic's draft, while that draft is the
revision it wrote. A request in flight ignores further clicks; a repeat of a created request adds nothing.

An experiment aimed at the Dark Mechanicus source gets its own panel instead (`CrossRepoCorrection.tsx`, view model
`crossRepoView.ts`, through `window.dm.crossRepoCorrections`). It names the target checkout (this folder and every
other tracked folder, each with its full path, or one picked in the dialog), the project and exact folder the work
goes to and whether it is available, and exactly what Create would write there: a new backlog epic owned by that
project (its own branch, runs, checkpoints and approvals), its tickets with keys planned there, the plan check, who
asked and the request key. Nothing is written until Create; a request in flight ignores further clicks and a repeat
adds nothing. Its states say what recovers them: an unavailable checkout keeps the request as a pending proposal
(Retry once it is back, or Withdraw); a link that failed after the target accepted the work is retried onto that very
epic; a target epic deleted since reads Epic missing and offers to create a new one, with confirmation; a request for
an experiment that cannot take new work writes nothing here and is refused, unless the target already holds its epic
(then only the link is recorded). Open leads to the epic in the target folder, with that project's normal Save, Start
run and checkpoint controls, and is offered only through a checkout of the very project holding it; the correction
epic's header links back to the epic that asked for it. Nothing in either project is saved, started, approved or
reopened by the panel (a completed source epic stays completed). Bring back its grades reads the correction epic's
sealed scorecards, scope starts, corrective tickets and planned sizes onto the source's receipt (cleared when the
request is linked to another epic); the panel lists each grade with the `{ reportId, assessmentId }` to cite, and the
orchestrator records results with `record_experiment_event` as usual. Before / after then sets each result against the
source baseline, the after side opening the correction epic.

The desktop's measurement controls:

- `recordHumanFeedback` (ratings, rescue time and planned review/playtesting time; minutes optional, at least 1 and at
  most 2,400 when given) and `recordEscapedDefects` (a person's defect reports, duplicates,
  reassessments, fixes and withdrawals, source `human`) need `feedback.record`, which only the desktop session holds;
  no MCP tool offers them. Each entry stores the desktop session and machine. Defect records of one call are stored
  all or none with server-assigned ids ordered in call order, and a follow-up cites a stored report. No desktop
  control calls `recordEscapedDefects` yet: until one does, escaped defects are recorded over MCP with
  `record_attempt_metrics` (metric `escaped_defect`, source `agent`), where any reporter may add a candidate or
  unassigned report and only a session holding `attempt.review` (an orchestrator) may attribute one or record a later
  duplicate, reassessment, fix or withdrawal (see [Verification and escaped defects](#verification-and-escaped-defects-p-inputs)).
- `setTicketBudget` sets or clears a ticket's prospective budget in the draft (`draft.edit`, a stale
  `expectedDraftRevision` is a `conflict`); only `savePlan` freezes it, and a dispatched ticket keeps the version its
  first claim pinned (`appliesTo: 'later_dispatches'`), so an edit can never improve a grade already read. On an epic
  never saved it answers `ticket: null`, `appliesTo: 'next_dispatch'`. Only the desktop may label a budget
  `person_estimate` (shown as "A person’s estimate") or change the amounts of a budget while it keeps that label: any
  other session doing either is refused with `unauthorized`, through `setTicketBudget` and `updatePlanDraft` alike. An
  agent may leave a person's budget as it is, replace it with a `planner_estimate` or `prior_tickets` budget, or clear
  it; the plan diff shows that change to the person before Save.

**Trust boundary.** Portable records are not authenticated: anyone who can write `.darkmechanicus` can author a
human-sourced observation file, exactly as they can author a review decision, and import accepts it after its schema,
ledger and reference checks. Commands and MCP tools refuse every agent; the files cannot. So the S read shows each
human entry's provenance (`HumanFeedbackEntry.recordedBy`): `this_machine` (names this machine and one of this
machine's own desktop sessions, from the local sessions table), `other_machine` (names another machine: imported, not
verifiable here) or `unattested` (names no recording desktop session or machine, which every desktop entry carries, or
claims this machine without one of its desktop sessions). It is a label, not a signature. Grades do not drop such
entries (that would make grades depend on the reading machine); the views label them.

**Unchecked submissions say why.** When the ledger refuses a submission's derived handoff checks, the submission goes
on unchecked and the refusal is logged as an `attempt.handoff_checks_refused` event (code and message). C's read lists
each unchecked submission with its reason (`CollaborationSignal.unchecked`: `checks_refused` with the logged refusal,
or `not_recorded` when this machine logged none).

### The project metrics summary

`getMetricsSummary` (capability `read`, on `DESKTOP_COMMANDS` and the MCP tool `get_metrics_summary`) is the one project-level read
the Metrics dashboard and the MCP metrics tools share. Input: optional `epicIds`, `until` (the cutoff; default now,
never later, the clock read once: only records stored and epics created by then are read, and an epic counts as
planned only with a plan saved by then) and `since`, which filters rows and trend entries only (epics with no run
active then, and sprints that ended before it, are left out; grades and measures still cover the whole history up to
the cutoff). It grades nothing itself:

- **Epic rows.** The grade is `epicAggregate`'s at the cutoff (`final`, `provisional`, `ungraded`, or `failed` on a
  confirmed mandatory failure, or `in_progress` while a run is still going). Token total, active time, summed effort
  and corrective share come from exactly the scopes that grade summed (`sources.efficiency`, the runs that executed
  work); token categories from `getRunMetrics` of those same runs, one read per run (they overlap, so they are never
  summed into a total; run metrics are read as stored now, so a run with records after an earlier `until` gives none);
  elapsed time from `projectRunTiming`. An attempt that reported nothing makes T's or K's total unknown, as it makes
  the component missing. An epic with no saved plan is ungraded with every measure unknown.
- **Totals** are recomputed from the raw measures of the epics that executed work (`totals.measuredEpicIds`), as the
  grader leaves out runs that executed nothing: a backlog, never-run or emptied epic keeps its row and adds nothing.
  Corrective share is Σ corrective ÷ Σ classified, never a mean of shares; no score or letter is ever averaged. The
  distribution counts rows by status and by the grade's own status (final, provisional and ungraded each counted).
- **Trend.** Each sprint with a report, or in which a run executed work, ordered project-wide by end time (open windows
  last), each naming its run (`runNumber`, `Run #N`): the scorecard frozen with its latest report revision (never
  regraded), `legacy_report` (ungraded) for a report from before scorecards, else its live grade; a run that only
  activated a sprint adds no entry. An entry is compared with the one before (a `scoreDelta`; `comparison.previous`
  names that entry's epic, run and run number) only when both were scored and share the policy, a known cohort and a
  closed window of the same basis (report cutoff or live cutoff). The cohort is the planned `workType/size/risk` keys
  of the sprint's work tickets with how many tickets hold each (`cohortTickets`; overhead tickets, by the role the
  scorecards froze for them, such as acceptance nodes, are no feature outcome and are left out): two cohorts match
  only with the same count per key, and a sprint with no work ticket or with one nobody sized has no known cohort,
  so it is never
  compared. Otherwise the entry says why (`policy_changed`, `cohort_changed`, `cohort_unknown`, `window_open`,
  `window_basis_changed`, `not_scored`, `first_entry`, and `cross_epic` when the entry before is another epic's and the
  policy or the cohort cannot vouch for comparing them), so `comparable` holds exactly when `scoreDelta` is a number.
- **Gaps.** The lowest components scored below 100 (a full score is no gap) with their evidence and the tickets it
  names (directly, through an attempt, or through a cited observation), confirmed failures of counted outcomes (with
  their run number), and corrective effort by cause, each cause citing only the classification records filed under it
  and the tickets they were spent on. Every ticket a gap names carries its key and title (`tickets`, `ticket`): from
  the plan saved last by the cutoff, else from the newest revision a run was pinned to (`removedAfterRevision`).
- **Coverage.** Every unknown measure is `null` with a reason (and the reported part as `lowerBound`), never zero, and
  is listed in `coverage.unavailable` with the ungraded epics.

Each run is graded once per read, every other run's cohort source (`cohortSource`: its records loaded and projected)
is built once per read and shared by every graded run (the `OtherRunSources` memo of `getRunEfficiency`), and each
observation filter is listed once per read (`readingObservations`), so the read's cost grows with the runs and their
records, not with how many read models look at the same run (`observationsHold.test.ts` counts the list queries,
including over a read that settles an expired lease). The hold is for a synchronous read only (a read returning a
promise throws); writing observations on its connection (an insert, or an epic deletion) ends it for the rest of the
read, and so does a commit by another connection, which is checked only for a read outside a transaction (inside one,
`BEGIN IMMEDIATE` keeps every other connection from committing); other writes, such as a lease the read itself
settles, keep it. The read is synchronous in the main process, so the Metrics dashboard loads it when it opens and on
a manual refresh only, never on a poll or on every event.

### The Metrics dashboard

A `Metrics` link (chart icon) sits directly below the MCP line in the sidebar footer while an initialized folder is
selected; it opens that folder's dashboard (`src/renderer/src/metrics/`), marks itself `aria-current="page"` while it is
open, and the choice persists in the stored selection (`Selection.metrics`), so a reload reopens it. Choosing an epic,
chat, agent screen, board or folder leaves it. The dashboard reads `getMetricsSummary({})` through `window.dm.command`
(live: no `until`, no `since`) when it opens and on Refresh, never on a timer or an event, and reads nothing else: the
summary itself carries run numbers and gap ticket keys and titles. Every measurement it shows is what the
summary holds: the policy and freshness (read time and cutoff), the distribution by status and by the grade's own status
(letters are counted, never averaged), the totals over the epics that executed work with their coverage, one row per
epic (an epic with no saved plan, or no run that executed work, reads `Nothing to grade yet`), the sprint trend and the
top gaps. The one table that is not from the summary is **Measurement capabilities**, shown last whenever the summary
has loaded (also in a folder with no epics): it is built in the renderer from `HOST_USAGE_SUPPORT`
(`capabilityRows` in `metricsView.ts`), one row per built-in agent with its Tokens and Active time each `Read from
the host` or `Not readable` and the source or reason, then a `Custom agents` row that is `Not readable` for both, so
an unreadable host's usage is never taken for a measured zero (it reads unavailable unless real numbers are relayed
with `record_attempt_metrics` / `record_run_metrics`). Each trend entry names its run (`Sprint 1 · Run #2`) and the
entry it is compared with (by that entry's own epic and run, which may be another epic's); a
comparable entry's change is the difference of the two scores as displayed, and one that is not comparable says why in
words (an unknown ticket cohort, another epic's sprint that neither policy nor cohort vouches for, …). A measure the
summary leaves `null` reads `unavailable (reason; ≥ the reported part)`, never 0. An epic row opens that epic on its
Scorecard; a gap opens its ticket on the Scorecard tab (a failure on the run it names), or the epic's Scorecard when it
names no ticket. A gap ticket the summary reports as removed names the latest revision that held it and offers the
epic's Scorecard (its panel cannot open on the current plan), and a landing for a ticket the plan no longer holds opens
the epic's Scorecard with a banner saying why. When the dashboard is narrower than the tables (the 1024 px window
minimum), each table row stacks into labelled lines that keep their table, row, header and cell roles. A folder
with no epics, or none that executed work, explains that measurements arrive once an agent connected over MCP runs an
epic; a failed read says so with Try again, Refresh shows `Refreshing…` while it runs, and a failed Refresh keeps the
data it read beside the error.

## Baselines

T and K compare against a baseline that existed before the work began.

1. **Kinds.** A **budget** is a ticket's pre-dispatch token or active-time budget, frozen in a saved plan
   revision. A **cohort** is the median of a frozen set of comparable prior tickets, identified by work type,
   size and risk (the planned reasoning level stands for risk), with its sample size and spread.
2. **Eligibility.** A candidate must match the metric; a budget must belong to the ticket being graded (a budget or
   cohort never applies to a run, sprint or epic grade, whose resource scores roll up from ticket measures);
   it must be frozen strictly before the ticket's dispatch (its first claim in the run); its value must be at
   least one token or millisecond. A cohort must match work type, size and risk, have at least **5** samples,
   and must not contain the subject ticket.
3. **Times fail closed.** A `frozenAt` or dispatch time that does not parse, or a missing dispatch time, proves
   nothing: the candidate is refused (`invalid_time`). `BaselineSubject` has a schema
   (`parseBaselineSubject`) that refuses such times outright.
4. **No eligible baseline is missing**, never zero and never an automatic 100.
5. **Choice among eligible candidates**: a budget before a cohort; then the latest `frozenAt`; then the higher
   version; then, for cohorts, the larger sample; then the lower baseline id. Every other candidate is listed
   with its rejection reason (`superseded` when it was eligible but lost).
6. **The grader trusts no label.** The grade input carries `dispatchedAt`, and `gradeSpace` re-runs the metric,
   ticket, freeze, value and sample checks on whatever baseline it is handed as selected, and for a ticket grade
   refuses a cohort that lists the ticket itself among its members (`contains_subject`); a T input with a tokens
   baseline (or K with active time) or a selected baseline below one unit is refused at parse. The grade records
   `dispatchedAt`, so the pre-dispatch rule can be audited later.
7. **No retrospective inflation.** Budgets are append-only versions. `frozenAt` and the dispatch time come from
   the server's lifecycle records, never from a caller, so a budget raised while a ticket executes is a version
   frozen after dispatch and cannot improve that assessment. It applies prospectively, to later dispatches.
   Budgets are edited in the plan draft and frozen by saving it: each saved revision that changes a ticket's budget
   is a version frozen at that save's server time, and a run uses the version of the revision the ticket was first
   claimed under (`getPlannedBaselines`, `src/core/services/plannedBaselines.ts`; see
   [architecture.md](architecture.md#metric-ingestion-and-planned-budgets)).

## Retrospective experiments and observation windows

A sprint retro may turn measured gaps into **experiments** (rules and storage:
[architecture.md](architecture.md#sprint-retros)). `getRetroFindings` ranks the gaps of the report's frozen scorecard
(failed verification, delivery gaps, coordination problems, concentrated corrective effort, budget overruns, missing
instrumentation) with magnitude, coverage and the records behind each; its hypotheses are labeled as hypotheses, and a
finding with several candidate causes, contradicting signals or sparse data carries no proposal. An experiment states:

- its **baseline**: one measure of a grade frozen with the report (the grade, a component score in points, or a frozen
  input such as `T.actual_ms` or `K.actual_tokens`), read by the server, never typed in;
- the **expected change** in the baseline's unit or percent, at least one **guardrail** (a measure that must not get
  worse past a threshold) and sized, specific **proposed work**;
- its **observation window**: `{ basis, count }`, the next 1–100 sprints, runs or tickets that start after the
  corrective work lands (its last work ticket accepted). Only a result citing a frozen grade at the baseline's level
  whose scope starts inside that window is **placed**; a result outside it, or before the work landed, counts as
  insufficient evidence.

The outcome is derived on every read, never stored: **regressed** when a guardrail is breached on a placed result
(that decides, even when a later result is clean, so a cheaper or faster run that fails a quality guardrail never counts
as improved); otherwise **improved** when the placed result moves at least the expected change toward the target,
**regressed** when it moves that much the other way, **unchanged** for less, and **insufficient evidence** when either
side is missing or estimated, units or policy differ, the task scope differs (an additive measure is compared per
ticket, and only with the same share of each planned size), the value was stated rather than read from a grade, or a
guardrail cannot be read. Every outcome is labeled **observational**: a before/after difference over different work is
not proof of cause.

Corrective work created from an experiment is DRAFT work with a Fireguard ticket by default and its own acceptance node
and human checkpoint; nothing is saved, adopted, run or approved for the person. How the work is created in this
repository or in the Dark Mechanicus source, and how to recover a request that stopped part way, is in
[the corrective work runbook](runbooks/corrective-work.md).

## Anti-gaming limits

Every rule that keeps a grade from being bought rather than earned, in one place:

- **Verification is a reviewer's.** Worker claims, summaries and stated grades are never inputs; missing review is
  Ungraded, and a confirmed mandatory failure caps the grade at F (59) however cheap or fast the work was.
- **Scope is frozen at the first dispatch.** Removing, splitting, renaming or rewording committed criteria or tickets
  never raises A; added scope, attempts, commits and changed lines are diagnostics, never rewarded.
- **Retries never help.** Every check of a rejected submission counts as failed for C (policy v2), so another attempt
  never raises C or the grade; retried, rejected, failed and superseded attempts keep their time and tokens in T and K.
- **Baselines are frozen before dispatch.** A budget saved during or after the work is a later version applied only to
  later dispatches; a cohort is read only from records stored before the subject's dispatch; a restarted run gets no
  fresh allowance (each ticket counts once per scope, from its first run).
- **Missing is never perfect.** Missing or zero actuals, partial telemetry and too few scored components give a missing
  component, Provisional or Ungraded, never 100. Leaving usage unreported never makes T or K look cheaper.
- **Sources are fixed.** Only a person records satisfaction, rescue and review time and a person's estimate; only the
  server derives verification, handoff checks, scope and elapsed time; the host's report of a delivery wins over the
  agent's; one delivery counts once.
- **Clarification is not a defect, and productive effort is not waste.** A purposeful clarification cannot be filed as
  a coordination defect, and planned tests, review and useful investigation count as productive in E.
- **Letters are never averaged.** Aggregates regrade raw measures; the dashboard and the summary count letters, never
  average them.
- **Reports are immutable.** A submitted scorecard is never regraded in place; late records show in a dated
  reassessment only, and a changed report is a new revision with its own scorecard.
- **Experiments cannot claim what they did not measure.** Baselines and results are read from sealed grades, outside
  the observation window or across different task scopes the outcome is insufficient evidence, and a guardrail breach
  outweighs any improvement.

## Worked examples

Each example is a checked-in fixture under `src/core/space/fixtures/rubric/` with its input and the grade policy v1
gives it (`policy-v1.json`); v1 inputs regrade byte for byte under the registered v1 policy. `boundaries.json` holds
eight more: real component inputs whose composites land exactly on 90, 80, 70 and 60 and one canonical unit below
each (89.999999 shows "89.9" B).

### Complete (`complete.json`): final B

| | Input | Score |
|-|-------|-------|
| S | ticket rating 4 (overrides the shared sprint rating 5) | 75 |
| P | verified; one attributed low regression (−5); one unassigned high regression shown only | 95 |
| A | 4 of 4 committed delivered (1 added, shown only) | 100 |
| C | 3 of 4 handoff checks passed, no defects | 75 |
| E | corrective 15 min of 75 min classified (share 0.2; 93.75% classified) | 70 |
| T | 72 min active against a 60 min budget (1.2×) | 90 |
| K | 230,000 tokens against the 200,000 budget frozen before dispatch (1.15×); the 600,000 budget saved mid-run is rejected | 92.5 |

Composite `(75 + 95 + 100 + 75 + 70 + 90 + 92.5) ÷ 7 = 85.357143`, shown **85.3, B, final**, coverage 7/7, each
effective weight 1/7.

### Sparse (`sparse.json`): provisional C

S 50 (inherited shared sprint rating 3), P 100, A 66.666667 (2 of 3; the removed item stays committed),
C 100. E missing (`not_reported`), T missing (`no_eligible_baseline`: the only cohort has 3 samples), K missing
(`host_unavailable`). Four scored components, coverage 4/7, effective weights 1/4 each:
`(50 + 100 + 66.666667 + 100) ÷ 4 = 79.166667`, shown **79.1, C, provisional** (`required_component_missing`).

### Too sparse (`too-sparse.json`): ungraded

Only P is scored. S has no rating (the sprint rating was not shared), A has no frozen scope, C has no handoffs,
E classified only 20% of effort, T lacks one attempt's telemetry, K was not reported. Coverage 1/7:
**ungraded** (`insufficient_coverage`), no score or letter. Forty commits and 9,000 changed lines do not help.

### Failure (`failure.json`): F

A mandatory check (`npm test`) and criterion c2 are confirmed failed. P 0, A 75, C 100, E 100, T 100 (one third of
the budget), K 100 (one fifth of the budget), S missing (optional). Uncapped `475 ÷ 6 = 79.166667`; the
mandatory-failure cap gives **59.0, F, final**. Low cost cannot hide the failure.

### Unverified (`unverified.json`): ungraded

The same cheap, fast work with every criterion claimed by the worker but no reviewed evidence: verification
`missing`, so **ungraded** (`verification_missing`) even though A, C, E, T and K all score 100.
