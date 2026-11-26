# Acceptance procedure: sprint learnings (real app, scratch profile)

Runs the built app against a scratch profile, scratch home, scratch Dark Mechanicus home and a scratch Git repository,
and checks the assembled learning lifecycle a person sees: a generated sprint learning card in **Ready for review**, the
person's **Approve and publish** taking it to **Done**, and the published learning with its source and integration
provenance under **Knowledge → Learnings**. It never touches the person's own profile (`%APPDATA%\dark-mechanicus`,
`~/Library/Application Support/…`), home (`~/.darkmechanicus`) or repositories.

The automated proof of every rule behind these screens is in the lifecycle tests; this procedure checks the real app:

- `src/core/services/learningLifecycle.test.ts`: one repository: a rejected attempt's exact reasons reach the retry,
  the sprint advance queues exactly one learning card (a replay returns the same card), claim, dispositions, the
  guardrail commit on the isolated branch, submission to Ready for review, the person's approval through main's
  coordinator, selection of the published learning by role and path in later claim packets and orchestrator context,
  replacement and retirement; repository-mode clone round trip of the learning, its integration record and the submitted
  card event; database mode settling without files; an ordinary card, a legacy run and a pre-v34 card link.
- `src/main/kanban/learningWorkflow.test.ts`: two repositories through the real desktop coordinator: a conflict in one
  repository is refused (card stays Ready for review, no branch moves, nothing published), a resolving attempt is
  approved, the app dies after the first repository's receipt, and the next launch's recovery completes that same
  operation and publishes exactly once.

Run both with `npx vitest run src/core/services/learningLifecycle.test.ts src/main/kanban/learningWorkflow.test.ts`.

## Isolation

Every path below lives in one fresh temporary directory `S`:

| Variable | Purpose |
| --- | --- |
| `S/home` | `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` of the app and of Git (its own `.gitconfig` identity, `autocrlf = false`) |
| `S/userData` | Electron `userData` (`app.setPath('userData', …)`): the folder registry and window state |
| `S/dm-home` | `DARKMECHANICUS_HOME`: the project databases |
| `S/learning-review` | the scratch Git repository the project is set up in, in repository storage mode |

Remove `DM_SESSION_TOKEN`, `DM_DESKTOP_PIPE`, `ELECTRON_*` and `NODE_OPTIONS` from the environment before launching, so
the app under test never reaches a running Dark Mechanicus or an agent session. Delete `S` afterwards.

## 1. Build

```sh
APP=<path to the Dark Mechanicus checkout under test>
cd "$APP" && npm ci --no-audit --no-fund && npm run build
git -C "$APP" rev-parse HEAD     # record with the evidence
```

## 2. Seed the scratch project

In `S/learning-review`: commit a README on `main`, switch to `epic/x` and commit the sprint increment. Then, as a script
bundled with esbuild from `$APP` and run with `ELECTRON_RUN_AS_NODE=1` (so `better-sqlite3` matches Electron), open a
`desktop` workspace (`openWorkspace({ repoRoot, homeDir: S/dm-home, role: 'desktop', transport: 'desktop' })`),
`initializeRepository({ mode: 'repo' })`, and drive the real services as the agents and the person would:

1. A run of a plan with sprint 1 = {DM-1, DM-2, DM-3 acceptance node}: DM-1's first attempt **rejected** with a reason
   and notes; DM-1 and DM-2 accepted; DM-3 accepted with a passing increment at `epic/x`'s head
   (`src/test/checkpointSeed.ts`: `seedRun`, `seedAttempt`, `acceptTickets`).
2. `submitSprintReport` (orchestrator), then the person's `approveAndAdvance` with an idempotency key, twice: both return
   the same `learningCard`.
3. `claimKanbanCard` (orchestrator) on that card. Create `packet.learning.branches[0].branch` at its base commit, commit
   a guardrail file on it (for example `docs/guardrails/migration-tests.md`), and switch back to `epic/x`.
4. `submitKanbanCard` through `kanbanCommands.submitKanbanCard.run` (worker): one disposition per snapshot item (the
   rejected attempt as `learning`, the rest `not_reusable`), one draft citing that item for roles `worker` and
   `orchestrator`, event `ticket.claimed`, path `src/core/db/**`, and the branch manifest.
5. `flushPortableState()`, close the workspace, commit `.darkmechanicus` (the clean-checkout rule), and track the folder
   in `S/userData/folders.json` (`createFolderRegistry(…).track(folder)`).

Expect `git status --porcelain` empty before launch.

## 3. Launch and inspect

Launch Electron on a small loader that sets the app path, `userData` and `home`, then requires `out/main/index.js`, with
`--remote-debugging-port`. Set the viewport to 1440×900 at scale 1 (`Emulation.setDeviceMetricsOverride`). Every step
below uses real clicks on the page.

| Step | Action | Expected result | Screenshot |
| --- | --- | --- | --- |
| a | Sidebar **Kanban**, open the generated card (`<KEY> Sprint 1 learnings`) | Lane **Ready for review**; status "Ready for review: nothing published yet"; Provenance run, sprint, report, checkpoint and snapshot; the proposed learning with roles, events and paths; **Approve and publish** enabled | `…-a-ready-for-review.png` |
| b | Click **Approve and publish** | Within two minutes the lane is **Done**; status "Done: approved, integrated and published", "1 learning record is active", guardrail landed on 1 repository; `git merge-base --is-ancestor <guardrail> epic/x` succeeds | `…-b-done.png` |
| c | Sidebar folder → **Epics** tab → **Knowledge** → **Learnings**; open the learning; scroll to **Source** | The learning is Active, revision 1, with its rule, check and applicability; Source links to the run, sprint, card and attempt; Evidence names the rejected DM-1 attempt; **Integration** names the `li_…` operation and "Integrated on epic/x at <commit>"; History shows "Published from approved learning card <KEY>" | `…-c-learnings-provenance.png` |

Throughout, the sidebar footer must read **Exported · all committed** and never **Export failed** (a submitted learning
card's event exports since the portable-event fix, 16b5a7ff). Record the renderer's `Runtime.exceptionThrown` events:
expect none. Quit through the app (`app.quit()`) and expect exit code 0.

## Evidence

Record the commit, the viewport, the seeded ids (card key and id, attempt, run, rejected attempt, guardrail commit), each
screenshot with what it shows, the footer text, renderer errors and the exit code. The DM-945 run of this procedure
(commit `d2015ca5`) is recorded on its ticket attempt with attachments `im_01m89jad3yw4adshpgp3bm9hqr` (a),
`im_01m89jb4me42bbxezn82dqatxs` (b) and `im_01m89jbfpce1fzndedkqyjz9a0` (c).
