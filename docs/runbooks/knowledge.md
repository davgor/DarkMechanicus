# Knowledge layers

The orchestrator runs from a short kernel guide, [`skills/orchestrator.md`](../../skills/orchestrator.md) (at most 800 words, served as the `darkmechanicus-orchestrator` prompt), plus knowledge facts. A fact is one rule cluster in a Markdown file with frontmatter (`id`, `type`, `title`, `scope.roles`, `scope.events`, `scope.topics`, `scope.paths`, `priority`, `supersedes`, `anchors`, `provenance`), parsed by `src/core/knowledge/fact.ts`.

Facts reach the orchestrator two ways. A command that changes run state pushes `context`: the facts scoped to the event it caused, within the default budget of 1,500 tokens. `get_context` pulls facts on demand: `{ event?, topics?, paths?, ticketId?, budgetTokens? }`, with an `event` or `topics` required, at most 10 topics and 50 paths, and a budget from 200 to 8,000 tokens.

Changing a built-in fact or the kernel is a change to the shipped skills: bump `SKILLS_VERSION` in `src/core/version.ts`.

## Layers and precedence

| Layer | Where it lives | Who changes it |
|-------|----------------|----------------|
| Built-in | [`skills/knowledge/orchestrator/`](../../skills/knowledge/orchestrator/) in this repository, bundled into the build (`src/core/knowledge/builtin.ts`) | Dark Mechanicus releases |
| Overall | The `knowledge/` folder (and its subfolders) of the repository that `<home>/knowledge.json` names, `<home>` being `~/.darkmechanicus` or `$DARKMECHANICUS_HOME`. Shared by every folder on the computer. | You, through the folder's **Knowledge** card |
| Repo | `.darkmechanicus/knowledge/` (and its subfolders) of the project | Whoever commits to the project |

Every `.md` file in a layer's folder is a fact; other files are ignored, symbolic links are not followed, and a file over 64 KiB is skipped with a diagnostic. The layers are read from disk on every call, so an edit takes effect on the next command with no restart.

Precedence is **repo over overall over built-in**:

- **Same `id`:** the fact from the higher layer replaces the lower one entirely (frontmatter and body). Two files with the same `id` in one layer keep the first by path order and report a diagnostic.
- **`supersedes`:** a fact listing other ids removes those facts from its own layer and every lower layer. It cannot remove a fact from a higher layer. Use it to retire a built-in fact under a different id, for example a repo fact `team.release-merge` with `supersedes: [orchestrator.merge-accepted]`.
- **Selection:** among the facts left, `get_context` keeps those whose `scope.roles` holds the session's role and that match the requested `event` or one of the `topics`. It ranks event matches first, then facts whose `scope.paths` match a requested path, then higher `priority`, then the higher layer, then `id`, and fills the budget in that order. Facts that do not fit are listed in `omitted` with their token cost; no fact is cut short.

A fact that fails to parse is skipped and reported in `diagnostics` (of `get_context` and of the **Knowledge** card) with its path and line; the other facts still load.

## Authoring a fact

A fact is one rule cluster: a frontmatter block between `---` lines, then a non-empty Markdown body. Keep it under about 400 tokens (1,600 characters) so several fit one event's budget. Name the file after the last part of its id.

### Frontmatter grammar

The frontmatter is a strict YAML subset, parsed by `src/core/knowledge/fact.ts` with no YAML library:

- One `key: value` per line, starting in column 1. Indented lines, nested maps and multi-line lists are refused.
- A key is letters and digits starting lowercase, or `group.key` with one dot: the `scope` fields are written `scope.roles:`, `scope.events:` and so on. A key may appear once.
- A value is one of:
  - an integer (`-?\d+`);
  - a double-quoted string, with `\"` and `\\` as the only escapes;
  - a bare string that does not start with `"`, `'`, `[`, `]`, `{`, `}`, `,`, `:`, `#`, `&`, `*`, `!`, `|`, `>`, `%`, `@`, a backtick or a space, and contains no `"`, `[`, `]`, `{`, `}` or `,` (quote a title that needs any of these);
  - an inline list `[a, b, "c, d"]` that closes on the same line, items bare or double-quoted, no trailing comma.
- Blank lines and lines starting with `#` are ignored.
- Unknown keys are refused. Errors name the file line, for example `line 4: duplicate key "title"`.

### Fields

| Field | Required | Type and limits | Default | Meaning |
|-------|----------|-----------------|---------|---------|
| `id` | yes | `^[a-z0-9][a-z0-9.-]{1,79}$` | | Unique id; the same id in a higher layer replaces this fact. Built-in ids are `orchestrator.<file name>`. |
| `type` | yes | `procedure`, `convention`, `decision`, `gotcha` or `command` | | What kind of rule it is; returned with the fact. |
| `title` | yes | string, 1 to 120 characters | | One line saying what the fact covers. |
| `scope.roles` | no | list | `[orchestrator]` | Roles that receive the fact. |
| `scope.events` | no | list of event ids | `[]` | Events that select the fact (pushed and pulled). An unknown event still loads but is reported. |
| `scope.topics` | no | list | `[]` | Topics that select the fact on a `get_context` pull. |
| `scope.paths` | no | list of globs | `[]` | Ranks the fact higher when a `get_context` request's `paths` match one of the globs (Node's `path.matchesGlob`, for example `packages/**`). It never selects a fact on its own. |
| `priority` | no | integer 0 to 100 | `50` | Higher ranks first among facts that match the same way. |
| `supersedes` | no | list of ids | `[]` | Ids removed from this layer and lower layers. |
| `anchors` | no | list | `[]` | Phrases the fact relies on (tool names, headings); for authors and checks, not returned in context. |
| `provenance` | no | string | none | Where the rule came from (a decision, ticket or document). |

A fact with neither `scope.events` nor `scope.topics` loads but is never selected.

### Events

The event a command pushes is fixed by the command; `get_context` accepts the same ids (`src/core/knowledge/events.ts`).

| Event | When it happens |
|-------|-----------------|
| `run.started` | An orchestrator run has started on an epic or board. Nothing has pushed context yet, so the kernel tells the orchestrator to pull it before setup. |
| `ticket.claimed` | A ticket attempt was claimed and is about to be worked. |
| `acceptance.claimed` | An attempt was claimed for acceptance review. |
| `attempt.accepted` | A reviewer accepted a submitted attempt. |
| `attempt.rejected` | A reviewer rejected a submitted attempt. |
| `attempt.failed` | A worker reported that an attempt failed. |
| `row_check.failed` | A row check on a ticket or attempt failed. |
| `sprint.reported` | A sprint report was produced at the checkpoint. |
| `checkpoint.approved` | A person approved the sprint checkpoint. |
| `kanban.claimed` | A Kanban card was claimed for work. |
| `run.recovery` | A run is resuming after an interruption or lost lease; the kernel tells the orchestrator to pull it. |

Every event selects at least one built-in fact, and the built-in facts for each event fit the default budget with nothing omitted (`src/core/knowledge/builtin.test.ts`).

### Topics

Topics hold pull-only material. The built-in facts use these, and the kernel lists them for the orchestrator:

| Topic | Covers |
|-------|--------|
| `folders-of-repositories` | Epics across a folder of Git repositories |
| `fallback-claim` | Nothing is eligible to claim |
| `lost-claim-response` | A claim whose response never arrived, expired leases |
| `integration-worktree` | The integration worktree, merging, branches, pausing |
| `plan-changes` | Plan revisions, follow-ups, investigation gates, decisions |
| `retro-redraft` | The retro, the redraft and the checkpoint |
| `required-leftover` | A sprint with a required leftover |
| `record-keeping` | Claim records, comments, attachments, run usage, grades and escaped defects |
| `host-catalog` | Registering the host and its models |
| `time-box` | Prerequisites before a claim, the five-minute check and the ten-minute stop-and-split for tickets and cards |

One built-in topic is not in the kernel's list: `space`, the measurement, grade and corrective-work rules in full. The kernel is at its 800-word limit, so the short `orchestrator.space-duties` fact, pushed with `run.started` and `run.recovery`, names it, as do the claim and landing pointers (`orchestrator.space-claim`, `orchestrator.space-landing`).

Overall and repo facts may use these topics or their own. A topic of your own is reached only by an orchestrator that asks for it, so name it where the orchestrator will see it (for example in a fact scoped to `run.started`).

### Worked examples

**Built-in** ([`skills/knowledge/orchestrator/row-checks.md`](../../skills/knowledge/orchestrator/row-checks.md), shipped with a `SKILLS_VERSION` bump; body abridged here):

```markdown
---
id: orchestrator.row-checks
type: procedure
title: "Run and record the combined check when a row is fully accepted"
scope.roles: [orchestrator]
scope.events: [attempt.accepted, row_check.failed]
scope.topics: [integration-worktree]
priority: 85
---

`get_run` and `get_ready_tickets` list each sprint's rows: ...
```

**Overall** (`knowledge/release-window.md` in your overall repository, for every project on this computer):

```markdown
---
id: team.release-window
type: convention
title: Merge to main only inside the release window
scope.events: [attempt.accepted, checkpoint.approved]
scope.topics: [integration-worktree]
priority: 70
provenance: "Team decision, 2026-10 retro"
---

Land an epic branch on `main` only Monday to Thursday, 09:00 to 16:00 local time. Outside the window, finish the sprint checkpoint and leave the merge for the person.
```

**Repo** (`.darkmechanicus/knowledge/merge-accepted.md` in one project, replacing the built-in fact of the same id there):

```markdown
---
id: orchestrator.merge-accepted
type: procedure
title: Merge accepted tickets with a rebase and never a merge commit
scope.events: [attempt.accepted]
scope.topics: [integration-worktree]
scope.paths: ["packages/**"]
priority: 90
anchors: [attempt.accepted]
---

This repository keeps a linear history: rebase each accepted ticket branch onto the sprint branch and fast-forward it. Run `npm run verify` in the integration worktree afterwards.
```

To check a fact, pull it: in the [measurement](#measurement) commands, point `--repo` at the project and ask for its topic, for example `{"topics":["integration-worktree"]}`. A fact that did not load shows up in `diagnostics` with its path and line.

## Setting up the overall repository

1. Create a Git repository with a `knowledge/` folder and add facts to it (Git Bash):

   ```sh
   git init ~/team-knowledge
   mkdir -p ~/team-knowledge/knowledge
   # write facts as ~/team-knowledge/knowledge/<name>.md, then:
   git -C ~/team-knowledge add knowledge
   git -C ~/team-knowledge commit -m "Add team knowledge"
   ```

   To share it, add a remote and push, or `git clone` an existing one instead of `git init`.
2. In the desktop app, open any folder's home and press **Choose…** on the **Knowledge** card. Pick the repository root, not its `knowledge/` folder. The choice is written to `<home>/knowledge.json` as `{"repository": "<absolute path>"}` and applies to every folder on this computer. Only a person can set it: no agent command writes it. **Change…** picks another repository and **Clear** removes it.
3. The card then shows the **Overall repo** path, the fact count of each layer (**Built-in**, **Overall**, **This folder**), the repository's **Git**, **Branch**, **Sync** (ahead or behind its upstream) and **Changes**, and any diagnostics. A missing `knowledge/` folder is reported as a diagnostic.
4. Sync it with Git yourself (`git -C ~/team-knowledge pull`, `git -C ~/team-knowledge push`). Dark Mechanicus never fetches, pulls, commits or pushes the overall repository; it reads whatever is checked out, on every call.

## Measurement

Token estimates are characters divided by 4. For a guide that is the file's size; for pushed context it is `usedTokens` from `get_context`, the sum of each selected fact's `ceil((title + body) / 4)`, which leaves out the JSON around it. Measured on skills version 1.12.0 with the built-in layer only (no overall repository, no repo facts) and the default budget of 1,500 tokens, so each event's figure is the `context` a command pushes for it.

| What | Characters | Words | Estimated tokens | Facts |
|------|-----------:|------:|-----------------:|------:|
| Old `skills/orchestrator.md` (skills 1.10.0) | 34,058 | 5,513 | 8,515 | |
| New kernel `skills/orchestrator.md` | 5,328 | 800 | 1,332 | |
| `run.started` | | | 1,361 | 8 |
| `ticket.claimed` | | | 1,447 | 8 |
| `acceptance.claimed` | | | 1,393 | 7 |
| `attempt.accepted` | | | 1,403 | 9 |
| `attempt.rejected` | | | 1,184 | 7 |
| `attempt.failed` | | | 1,216 | 7 |
| `row_check.failed` | | | 405 | 2 |
| `sprint.reported` | | | 858 | 6 |
| `checkpoint.approved` | | | 1,443 | 8 |
| `kanban.claimed` | | | 1,421 | 6 |
| `run.recovery` | | | 1,378 | 7 |

No event omitted a fact. The orchestrator starts from the kernel (1,332 tokens) instead of the old guide (8,515); with the first push, `run.started`, that is 2,693, and each later push adds 405 to 1,447. Every event leaves at least 50 tokens of the budget for overall and repo facts (`builtin.test.ts` checks it).

**Method.** Sizes of the guides, from the repository root in Git Bash (`f1590fa` is the last commit with the single guide):

```sh
git show f1590fa:skills/orchestrator.md | wc -c -w
wc -c -w skills/orchestrator.md
```

Pushed context per event: `get_context` needs an `orchestrator` session, because the built-in facts are scoped to that role and a `dm` CLI session without a grant is a reader, which gets none ([`cli.md`](cli.md#authority-there-is-no---role)). A grant cannot be issued from the command line, so the measurement talks to the MCP server, whose role comes from its launch flags ([`mcp-setup.md`](mcp-setup.md)). From the repository root after `npm run build`, in Git Bash, this initializes a scratch Git repository under a scratch home (your `~/.darkmechanicus` is untouched), then sends one `get_context` per event. Each request is sent only after the response to the previous one has arrived, and the server's input is closed after the last response, so no step depends on timing. It prints the event, `usedTokens`, the number omitted and the fact ids, and keeps the raw responses in `context.jsonl`.

```sh
export DARKMECHANICUS_HOME="$(mktemp -d)"
scratch="$(mktemp -d)" && git init -q "$scratch"
node -e '
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const events = ["run.started", "ticket.claimed", "acceptance.claimed", "attempt.accepted", "attempt.rejected", "attempt.failed",
  "row_check.failed", "sprint.reported", "checkpoint.approved", "kanban.claimed", "run.recovery"]
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
const requests = [
  { jsonrpc: "2.0", id: "hello", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "measure", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  call("init", "initialize_repository", {}),
  ...events.map((event) => call(event, "get_context", { event }))
]
const server = spawn(process.execPath, ["out/main/mcp.js", "--repo", process.argv[1], "--role", "orchestrator"], { stdio: ["pipe", "pipe", "ignore"] })
const out = fs.createWriteStream("context.jsonl")
let buffered = ""
let waitingFor = null
function sendNext() {
  while (requests.length > 0) {
    const request = requests.shift()
    server.stdin.write(JSON.stringify(request) + "\n")
    if (request.id !== undefined) return (waitingFor = request.id)
  }
  server.stdin.end()
}
server.stdout.on("data", (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf("\n")) !== -1) {
    const line = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    if (line.trim() === "") continue
    out.write(line + "\n")
    const { id, result, error } = JSON.parse(line)
    if (id !== waitingFor) continue
    const data = result?.structuredContent?.data
    if (error || result?.isError) console.error(id, "failed:", JSON.stringify(error ?? result.structuredContent))
    else if (events.includes(id)) console.log([id, data.usedTokens, data.omitted.length, data.facts.map((f) => f.id).join(" ")].join("\t"))
    sendNext()
  }
})
server.on("exit", (code) => out.end(() => process.exit(code ?? 1)))
sendNext()
' "$scratch"
```

Run it in a new shell (it exports `DARKMECHANICUS_HOME`) and delete `context.jsonl` afterwards. To include your own layers, drop the `DARKMECHANICUS_HOME` line (your overall repository then counts), set `scratch` to your initialized project instead of creating one, and delete the `call("init", "initialize_repository", {}),` line.

## Orchestrator guide mapping

Skills version 1.11.0 split the single orchestrator guide (skills version 1.10.0, about 5,500 words) into the kernel and built-in facts. The text was reworded only where a rule was split or pointed to another section; no rule was dropped or changed in meaning. A fact id `orchestrator.<name>` is the file `skills/knowledge/orchestrator/<name>.md`.

| Old heading | Now carried by |
|-------------|----------------|
| Description line | Kernel description line (unchanged) |
| `# Orchestrator` | Kernel `# Orchestrator` (identity, role, subagent workers, collaboration policy, planning guides; unchanged except that the elapsed-time sentence names topic `time-box` where the old guide said "below") |
| `## Decision ownership and questions` | `orchestrator.decisions` (own decisions, escalation, limits of autonomy), `orchestrator.worker-questions` (workers and reviewers ask you) |
| `## Sprint boundaries and investigation gates` | `orchestrator.sprint-shape` (planning: one sprint, investigation first, when to propose another), `orchestrator.investigation-gate` (continue after an accepted investigation), `orchestrator.saved-sprint-boundaries` (honor saved boundaries, Definition of Done once per sprint acceptance) |
| `### Five-minute check, ten-minute stop-and-split (cards too)` | `orchestrator.claim-prerequisites` (bullet 1: prerequisites before a claim, one worker in 5 to 10 minutes; pushed with the events after which the next claim happens and with `kanban.claimed`), `orchestrator.time-box` (bullets 2, 3 and 7: clock and ledger, 5-minute check, 10-minute stop, checkpoint reports; pushed with `ticket.claimed`, `acceptance.claimed`, `kanban.claimed` and `run.recovery`), `orchestrator.time-box-limits` (bullets 4 to 6: diagnostic rounds, safe stops, the declared verification exception; pushed with `ticket.claimed`, `acceptance.claimed` and `kanban.claimed`); all three under topic `time-box` |
| `## Rules that always apply` | Kernel `## Rules that always apply` (verbatim) |
| `## 1. Set up` | `orchestrator.setup` (steps 1 to 3), `orchestrator.register-host` (step 4), `orchestrator.start-run` (step 5), `orchestrator.branch-model` (the epic and sprint integration branches); kernel `## The loop` step 1 |
| `## 2. The execution loop` | `orchestrator.ready-tickets` (steps 1 and 2), `orchestrator.fallback-claim` (nothing eligible), `orchestrator.claim-ticket` (step 3), `orchestrator.dispatch-worker` (step 4), `orchestrator.heartbeat` (step 5), `orchestrator.review-attempt` (steps 6 and 7, the acceptance node exception), `orchestrator.merge-accepted` (step 8), `orchestrator.retry-escalation` (rejected tickets become retryable); kernel `## The loop` step 2 |
| `## 3. Integration and the acceptance round` | `orchestrator.integration-worktree` (intro and **Where**), `orchestrator.merge-accepted` (**Merge each accepted ticket**), `orchestrator.row-checks` (**Row checks**), `orchestrator.acceptance-round` (**The acceptance round**, steps 1 to 3), `orchestrator.acceptance-landing` (steps 4 to 6); kernel `## The loop` step 3 |
| `### Folders of repositories` | `orchestrator.repo-folders-branches` (intro, the epic branch per repository, never switch a child checkout), `orchestrator.repo-folders-workers` (workers, landing, Definition of Done, the redraft) |
| `## 4. Failures, retries, and escalation` | `orchestrator.retry-escalation` (a ticket is rejected), `orchestrator.repeated-escalations` (report repeated escalations), `orchestrator.attempt-blocker` (a worker reports a blocker), `orchestrator.expired-lease`, `orchestrator.lost-claim-replay` (a lost claim response, the response never reached you), `orchestrator.lost-claim-dispatched` (a worker may hold the token, last try, no idempotency key), `orchestrator.pause-and-branch` (`pause_run`, `resume_run`, `cancel_run`, `branch_changed`) |
| `## 5. Sprint checkpoint` | `orchestrator.sprint-report` (claim the node first, step 1), `orchestrator.checkpoint-wait` (step 2), `orchestrator.advance-sprint` (steps 3 to 5); kernel `## The loop` step 4 |
| `### The retro and the redraft` | `orchestrator.redraft-call` (intro, step 1), `orchestrator.redraft-refine` (step 2), `orchestrator.redraft-approval` (steps 3 and 4, the gate paragraph) |
| `### When the sprint has a required leftover` | `orchestrator.required-leftover` (the case, steps 1 to 3), `orchestrator.required-leftover-finish` (steps 4 to 6, a leftover in the final sprint) |
| `## 6. Plan changes and recovery` | `orchestrator.adopt-revision` (pinned revision, adoption, carry forward), `orchestrator.follow-up-proposals` (follow-ups are proposals), `orchestrator.repeated-escalations` (profile corrections), `orchestrator.takeover-and-truth` (imported runs, source of truth after an interruption) |
| `## 7. Record keeping` | `orchestrator.record-keeping` (claim records, decisions, `add_comment`, `list_comments`), `orchestrator.attachments` (reference images) |
| `## 8. Running a Kanban card` | `orchestrator.kanban-launch` (Play and `launch_kanban_cards`), `orchestrator.kanban-run` (applying the prerequisite, single-worker and 5-minute/10-minute rules, steps 1 to 6) |
| `## 9. Measurement, grades and corrective work` (added by the SPACE scorecards epic on the single guide, skills version 1.10.0 on that branch; carried into facts by skills version 1.12.0) | Topic `space` holds every rule in full; short facts push one sentence per obligation with every event after which its trigger can occur (`src/core/knowledge/builtin.test.ts` lists each obligation with its events). `orchestrator.space-duties` (pushed with `run.started` and `run.recovery`: records complete and honest, each row's usage, grades relayed as returned and never deciding, acceptance only on a review decision, escaped defects, `in_progress` when corrective work starts; names topic `space`), `orchestrator.space-claim` (pushed with `ticket.claimed` and `acceptance.claimed`: review decision, corrective ticket starts its experiment), `orchestrator.space-landing` (pushed with `attempt.accepted`: corrective work landed, `completed`). In full: `orchestrator.space-usage` (**Usage**; topics `record-keeping` and `space`, named by `orchestrator.row-checks` after each row), `orchestrator.space-review-evidence` (**Evidence**; topic `space`), `orchestrator.space-grades` (intro and **Grades**; pushed with `sprint.reported`, topics `space` and `record-keeping`), `orchestrator.space-escaped-defects` (**Escaped defects**; pushed with `row_check.failed`, topics `space` and `record-keeping`), `orchestrator.space-experiments` (**Experiments**, restating on a new report revision; pushed with `sprint.reported`, topic `space`), `orchestrator.space-experiment-progress` (**Experiments**, statuses and results; pushed with `sprint.reported` and `checkpoint.approved`, topic `space`), `orchestrator.space-corrective-work` (**Corrective work**; pushed with `sprint.reported` and `checkpoint.approved`, topics `retro-redraft` and `space`) |

Cross-references in the old guide ("see section 3", "above", "below") now name the fact id, the `get_context` topic or the event that carries the rule. The kernel's `## The loop` and `## Knowledge: pushed context and get_context` sections are new: the loop is a skeleton of the steps above, and the knowledge section tells the orchestrator to pull `run.started` before setup (nothing has pushed context yet), to pull `run.recovery` after an interruption, and which topics exist.

The checks that guard the split: `src/core/knowledge/builtin.test.ts` (parsing, budgets, topics, fact-id references, kernel word count), the orchestrator phrases in `src/mcp/skills.test.ts` (checked across the kernel and the built-in facts) and `src/mcp/server.test.ts` (every tool a skill or built-in fact names exists).
