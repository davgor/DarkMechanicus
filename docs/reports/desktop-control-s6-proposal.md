# Proposed desktop-control build sprint (DM-1043)

This is the desktop-control build sprint, written in the plan's own format so that the Magos's retro redraft can save
it without going back to the code. It applies only on **GO** at the Sprint 5 checkpoint. The file keeps its name,
`desktop-control-s6-proposal.md`, for continuity, but Sprint 6 is now Antics (revision 17). Below, the sprint is called
**the desktop-control build sprint** throughout.

The design it builds is [`docs/design/desktop-control.md`](../design/desktop-control.md), cited here as **D §n**. The
probe reports are cited as **B:n** (`docs/reports/desktop-control-backend.md`) and **O:n**
(`docs/reports/desktop-control-overlay.md`).

**Source paths.** Every source path below was checked to exist at `sprint/agent-gui-s5` `df11d4fb`. A path marked
**(new)** does not exist yet and is created by that ticket. Line numbers are from `df11d4fb`; a ticket that finds a
line moved looks the symbol up again.

## Placement (the person decides at the S5 checkpoint)

The sprint is **placement-neutral**: it works whether it runs before or after Antics. Its fields only ever refer to
"the previous sprint". When saving it, the redraft makes the following edits for the placement the person chooses.

**Before Antics.** The order becomes S5 → desktop-control build → Antics → Codex.

1. Move DM-1071, the delivery check of Sprint 5, into this sprint as its opening ticket. Drop `dc-delivery`.
2. Give Antics a "previous sprint" delivery check copied from DM-1092.
3. Reword Antics' entry criteria `n1` and `n3`, its exit criterion `x1` and its acceptance criterion `c1` from
   "Sprint 5" to "the previous sprint".
4. Keep Codex's `n1` as it is: it already reads "the immediately previous sprint".

**After Antics.** The order becomes S5 → Antics → desktop-control build → Codex.

1. Keep `dc-delivery` as written. It checks Antics.
2. Codex's `n1` already names "a desktop-control build sprint placed after it", so it needs no edit.

**Final or not.** Codex (S7) follows in both orders, so this sprint is **not** the final sprint as saved.

- Its acceptance criterion `c14` still carries the closeout, so the text stays correct if the plan later changes.
- **If the sprint is final**, its report's `epicOutcome` reports every success criterion s7–s16 with evidence:
  - s12 met by this sprint's evidence;
  - s15 per the adopted wording, or reported unmet if Codex never ran.

  No criterion is reported met without evidence.
- **If it is not final**, the report states that a later sprint follows and carries no `epicOutcome`.

## Sprint fields

**Goal** (1,261 characters):

> Desktop-control build sprint. A Skitarii (OMP) GUI chat gets Codex-level total control of the whole Windows desktop
> through OMP's built-in computer use, enabled per chat in DM's per-chat --config overlay after one native confirmation
> (no Windows Hello, no per-action approval) and never in the person's global OMP config. While control is active, a
> light red border with "A Skitarii agent is controlling the desktop" covers every display, the chat header shows a
> badge and Stop, the agent tree row shows a lock, and DM's own human-only controls (checkpoint, Kanban review and
> delete, retry grants, browser site Allow, loosening confirmations, the enable itself) are locked in main. A physical
> ESC ends control instantly (overlay within 10 ms, computer-use tree within 150 ms) while the agent's injected ESC
> reaches the app; every other stop path and every fail-closed path (hook helper death, lost heartbeat or ping, crash)
> ends it within its stated bound. Exactly one chat controls the desktop, control never survives a relaunch or
> restart, the Magos arbiter never decides desktop prompts, and desktop screenshots show inline. Everything is proven
> unattended with a fake computer-use persona and a fixture window; the person presses ESC once at the checkpoint.

**Entry criteria:**

- **n1.** The previous sprint (Sprint 5, or Antics if the person placed this sprint after it) was merged to main
  before its human checkpoint and accepted by the person. Two cases:
  - **It published a release:** the person's controlled update restart happened, and the opening delivery check
    records the installed version and Magos continuity before any other claim.
  - **It published no release:** `scripts/release-paths.mjs` counts only `src/`, `skills/`, `build/` and the build
    config files (`:12-25`). A docs-and-scripts-only increment therefore makes Deploy skip (`.github/workflows/deploy.yml:49`),
    and no update restart happens. The opening delivery check then verifies the merge on main and the recorded Deploy
    skip, and does **not** wait for a restart message that will never come.
- **n2.** The Windows execution-host preflight from the plan rationale passes on the current main before the first
  claim:
  - git HEAD;
  - node and npm;
  - `node_modules` matching the lockfile;
  - `ELECTRON_RUN_AS_NODE` stripped, so that `npx electron --version` prints v42.x;
  - `npm run build`;
  - `npx vitest run src/main/terminals/agentExecutable.test.ts`.
- **n3.** Claim the opening delivery-check ticket only after the person approved the previous checkpoint. If that
  sprint published a release, also wait until the person chose the live-host update restart and the fixed
  `[App restarted after an update ...]` message arrived. Until then, record the exact pending prerequisite and claim
  nothing. Never restart the person's app.
- **n4.** The person chose **GO** at the Sprint 5 checkpoint, and this sprint was saved and adopted before that
  checkpoint was approved.
- **n5.** The host has `omp` ≥ 18.20.2 signed in, for the bounded live-facts probe and the live smoke, and the desktop
  is drawn: the `scripts/spike/desktop/screen.ps1` check returns `ok`. If omp is absent or signed out, the Magos asks
  the person. It never installs omp or signs in on the person's behalf.

**Exit criteria:**

- **x1.** The delivery-check evidence shows the previous sprint's increment on main, its release or recorded Deploy
  skip, the installed Windows app at the right release or later, and the Magos resumed.
- **x2.** The live-facts report settles, within 30 minutes and $1, three facts with real omp:
  - whether OMP writes computer screenshots under the launch's `TEMP`;
  - whether a resumed session with the default overlay reports `Computer use: disabled`;
  - how long the forced stop of the GUI job takes to end a real OMP tree.

  The person's global OMP config is unchanged before and after.
- **x3.** An OMP GUI chat enables control only through main:
  - after one native confirmation;
  - by relaunching on its same session with `computer: {enabled: true, display: all}` in its own overlay only;
  - confirmed by `/computer status` and `get_state`.

  Claude, terminal-surface and non-Windows chats are refused. A second chat's enable is refused while one owns
  control. Every other launch, including restart resume, the Techmarine boot resume and lazy resume, comes back Off.
- **x4.** The overlay is one transparent, click-through, non-focusable, content-protected, screen-saver-level window
  per display, created in main. `src/main/windows.test.ts` was updated deliberately to allow exactly `index.ts` and the
  overlay module.
- **x5.** The ESC hook helper:
  - kills on a physical Escape key-down only;
  - passes injected Escapes through;
  - fails closed on its own death, a heartbeat gap over 1000 ms or a ping gap over 2500 ms;
  - stops its ping thread before unhooking.
- **x6.** Every kill path (physical ESC, header Stop, chat stop and delete, untrack, agent removal, quit, OMP exit,
  hook death, heartbeat and ping loss, DM crash) runs one kill. The overlay is removed within 10 ms and the tree has
  ended within 150 ms of the kill decision, with no injected key after. The lock is lifted only after the tree has
  exited.
- **x7.** While control is active, main refuses every locked control:
  - every `HUMAN_ONLY_CAPABILITIES` command;
  - the locked channels;
  - the approving or loosening native confirmations.

  Refusals return `desktop_control_active`. The renderer mirrors the lock, and Stop stays available.
- **x8.** The Magos arbiter never decides a prompt of the controlling chat or any computer-use prompt: a registered
  `never_arbitrate` predicate.
- **x9.** The header toggle, badge and Stop, the tree-row lock and the `desktop_control` notification for a
  fail-closed end ship. Desktop screenshots show inline through the S3 chat-image path, and no `omp-computer-*.png` is
  left after control ends.
- **x10.** The built-app `desktop-*` e2e steps pass with zero retries. The capture states at 1024×768 and 1440×900
  are attached and inspected. The live smoke with real omp on the fixture passes. The full Definition of Done passes
  at acceptance.
- **x11.** Before the human checkpoint, the Magos delivers the combined increment to main by protected pull request:
  squash, required checks, no bypass and no rerun-to-green. It owns CI Checks → Deploy publication and records the
  packaged Windows journey from `deploymentVerification`. This saved-plan text explicitly authorizes that
  pre-checkpoint PR, merge and rollout. The checkpoint report names the published version, and only the person
  controls any live-host Restart now.
- **x12.** The final-sprint closeout follows the Placement section above.

**`deploymentVerification`** (1,825 characters):

> Deliverable: on Windows the person turns on Desktop control for a Skitarii GUI chat, sees the red border with the
> note on every display and the header badge, and a physical ESC ends control at once.
> Before checkpoint, finish PR/CI/Deploy rollout and identify the published Windows package containing this sprint
> (a Deploy skip is a failure here: this sprint changes src/). Open it with an isolated profile and folder and the
> seeded fake omp computer-use persona (the e2e --exe mode) plus the desktop fixture window, recording exe and
> profile provenance and the runtime header version. No personal data or credentials in the proof.
> Journey (fake omp, isolated profile):
> - The header shows Desktop control Off; enabling shows one native confirmation; after it the overlay windows are
> listed topmost with affinity 0x11 on every display, the badge and tree lock show.
> - The agent drives the fixture (click, text, injected Escape); the fixture logs Escape and control stays on.
> - Checkpoint Approve, Kanban Delete and site Allow are refused with desktop_control_active.
> - Stop ends control: overlay gone, tree ended, lock lifted; a relaunch comes back Off.
> Agent live smoke before the checkpoint (real omp, ≤ 5 min, ≤ $0.50): enable control on a fixture-only chat; the
> fixture reads back clicks, text and Escape; Stop ends it; no omp-computer-*.png remains; the global OMP config hash
> is unchanged.
> Person's single step at checkpoint, in the installed app with the isolated profile and the fake persona: turn on
> Desktop control for the fixture chat; confirm the light red border and note are visible on every display (this
> also settles whether a content-protected border shows through RDP); press Esc on the physical keyboard. Expected:
> the border disappears at once and the chat header shows Desktop control ended (physical-esc).

**Checkpoint mode:** `human`.

**Acceptance node:** `dc-acceptance`, below, with one criterion covering each ticket.

## Tickets

Dependencies are by ref. Every ticket also depends on `dc-delivery`, the opening delivery check, which gates every
other claim. When the person places this sprint before Antics, that ticket is DM-1071, moved here.

Edges, written as **depends on**:

| Ticket | Depends on |
| --- | --- |
| `dc-live-facts`, `dc-overlay`, `dc-hook` | `dc-delivery` |
| `dc-launch` | `dc-live-facts` |
| `dc-owner` | `dc-launch` |
| `dc-kill` | `dc-owner`, `dc-overlay`, `dc-hook` |
| `dc-lock-main`, `dc-never-arbitrate`, `dc-ui` | `dc-owner` |
| `dc-lock-ui` | `dc-lock-main` |
| `dc-screens` | `dc-live-facts`, `dc-kill` |
| `dc-e2e` | `dc-kill`, `dc-lock-ui`, `dc-never-arbitrate`, `dc-ui`, `dc-screens` |
| `dc-docs` | `dc-e2e` |
| `dc-acceptance` | every ticket |

Every implementation ticket's body ends with the epic's standard tail: Context, Execution host (Windows-first,
POSIX-safe), Targeted checks (`npx vitest run <each test file touched>`, `npm run typecheck`, `npm run lint`,
`npm run deadcode` if exports change), and Visual work (capture the real surface, open each PNG and attach it). The
same rules from the Sprint 5 tickets hold everywhere:

- no consent verifier, allowlist or approval broker for the agent's own actions;
- drive only fixture windows a test launched;
- never type into the person's windows;
- close everything opened;
- unique temp roots.

---

### dc-delivery: Delivery check of the previous sprint (when placed after Antics)

- **Size** small · **Reasoning** medium · **Kind** implementation (read-only verification)
- **Outcome.** This is DM-1092's four-part evidence record for the immediately previous sprint:
  1. the merge M is on `origin/main`;
  2. Deploy published a release vX containing M, or recorded the changed-path skip;
  3. the installed app runs vX or later;
  4. the Magos resumed (same chat and session as the `pre-restart:` line, or DM-1040's fallback).

  **No-release case:** when Deploy skipped, X is the latest release published at the previous checkpoint. There was
  no restart, so the ticket records "no restart expected" and does not wait for the restart message. The ticket is
  read-only: no code, no installs, no restarts.
- **Source locations.** `.github/workflows/deploy.yml` (`:26`, `:49`), `scripts/release-paths.mjs` (`:12-25`),
  `src/main/autoUpdate.ts`, `package.json`, `docs/reports/agent-gui-chat-delivery.md`.
- **Tests.** None. The evidence is the command output for each step.
- **Acceptance criteria.**
  - c1: Evidence names the previous sprint's merge M on `origin/main` and its release vX, or the recorded Deploy skip
    with X defined as above.
  - c2: Evidence shows the installed Windows app at vX or later and the same Magos chat and session live. In the
    no-release case it records that no restart was expected, and the Magos still live on its pre-checkpoint session.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | The person approved the previous checkpoint, and that sprint published vX and the person restarted | Run DM-1071's steps for the previous sprint | All four hold; any failure fails the ticket with evidence | Command output pasted in the evidence |
  | The previous sprint's Deploy recorded a changed-path skip | Run the steps without waiting for a restart message | Merge on main, skip recorded, installed version = latest earlier release, Magos live | Command output; `git diff --name-only` piped to `node scripts/release-paths.mjs` prints `false` |
- **Dependencies.** None. This is the opening ticket.

### dc-live-facts: Settle the remaining backend facts with real omp, bounded

- **Size** medium · **Reasoning** high · **Kind** implementation (probe)
- **Outcome.** A bounded probe: 30 minutes and $1 of model spend, with start and end times recorded. It runs only
  against fixture windows the probe launches, under unique `%TEMP%\dmlive-*` roots, with the global
  `~/.omp/agent/config.yml` hash recorded before and after. It settles three facts:
  1. **Screenshot location.** omp is launched with `TEMP`/`TMP` set to a probe folder and `computer.enabled` in the
     overlay. Does a `computer.screenshot({ silent: true })` write `omp-computer-*.png` there, and nothing in the real
     `%TEMP%`? (D §5.7; B:175-177)
  2. **Resume.** A session runs one turn with the computer overlay, exits, and is relaunched with `--resume` and the
     default overlay. Does `/computer status` print `Computer use: disabled` and does the `get_state` marker show
     false? (D §3.4; B:115-116, B:136-137)
  3. **Kill timing.** How long does the GUI job's forced stop take to end the real OMP tree? Kill the
     `windowsAgentJob` supervisor and run `taskkill /T /F`, and compare both against O:167's 135 ms. (D §6.2)

  Each fact ends PROVEN, DISPROVEN with the fallback named, or UNPROVEN. An inconclusive fact is not PROVEN.
- **Source locations.**
  - `scripts/spike/desktop/omp-computer-probe.mjs`, `scripts/spike/desktop/omp-computer-off.mjs` and
    `scripts/spike/desktop/omp-transcript.mjs`, extended by `scripts/spike/desktop/omp-live-facts.mjs` **(new)**;
  - `src/main/agentChat/windowsAgentJob.ts` (`:137`, `:206`) and `src/main/agentChat/agentProcess.ts` (`:206-224`);
  - the report goes to `docs/reports/desktop-control-live-facts.md` **(new)**.
- **Tests.** `npx vitest run scripts/spike/desktop/escDecision.test.mjs` stays green. The probe itself is the
  verification, and its JSON record is committed beside the report.
- **Acceptance criteria.**
  - c1: The report gives a verdict for each of the three facts with its evidence (file listing, `command_output`
    text, timings), the clock, the cost, and the unchanged global config hash.
  - c2: No `omp-computer-*.png` written by the probe remains in either folder, and every probe process and fixture is
    closed (process list before and after).
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | omp ≥ 18.20.2 signed in; fixture launched | Run `omp-live-facts.mjs --fact temp` | A verdict on where `omp-computer-*.png` lands, with the directory listings | The JSON record and the report |
  | A session that ran one turn with `computer.enabled: true` | Relaunch with `--resume` and the default overlay; send `/computer status` | `Computer use: disabled …`, or a recorded DISPROVEN with the fallback (a resume never reuses the session while control is off) | The redacted rpc lines in the record |
  | A live rpc-ui OMP under the owned job | Force-stop the supervisor; separately run `taskkill /T /F` | Both end times recorded; the OMP pid is gone | The JSON record |
- **Dependencies.** `dc-delivery`.

### dc-launch: Write the computer overlay and the screenshot TEMP only for a desktop-control launch

- **Size** small · **Reasoning** medium
- **Outcome.**
  - `writeOmpFiles` (`src/main/terminals/ompSession.ts:96-106`) takes an optional `computer: { tempDir }`. When given,
    it appends `computer:\n  enabled: true\n  display: all\n` to the overlay (B:99-103). It never writes
    `tools.approval`, because held control is retired by decision (D §10). The default is no `computer` block, and
    the overlay is rewritten at every start (`:104`).
  - `agentChatLaunch`'s `environmentFor` (`src/main/agentChat/agentChatLaunch.ts:41-50`) sets `TEMP` and `TMP` to
    `tempDir` only when the launch input carries it. If `dc-live-facts` disproved fact 1, it keeps `TEMP` and records
    the fallback.
  - The terminal start (`src/main/terminals/terminalSessions.ts:608`) never passes `computer`.
  - A source-scan test, in the style of `src/main/windows.test.ts`, pins that only the desktop-control module passes
    `computer:` to `writeOmpFiles`.
- **Source locations.** `src/main/terminals/ompSession.ts`, `src/main/agentChat/agentChatLaunch.ts`,
  `src/main/agentChat/agentChatSessions.ts` (`:802-813`, `startFiles`), `src/main/terminals/terminalSessions.ts` (`:608`).
- **Tests.** `src/main/terminals/ompSession.test.ts`, `src/main/agentChat/agentChatLaunch.test.ts`,
  `src/main/agentChat/desktopOverlayCallers.test.ts` **(new)**.
- **Acceptance criteria.**
  - c1: An overlay written with `computer` contains exactly the `computer` block above and no `tools.approval`. One
    written without it contains no `computer` key, even when the previous file had one.
  - c2: The launch env carries `TEMP`/`TMP` = the chat's `computer` folder only for a desktop-control launch. The
    argv is unchanged apart from the existing `--config` path.
  - c3: The source scan finds `computer:` passed to `writeOmpFiles` only from the desktop-control module.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | A chat folder whose `config.yml` has the computer block | `writeOmpFiles(…, { fresh: false, role })` with no `computer` | The file has no `computer:` line | `ompSession.test.ts` |
  | A desktop-control launch input with `tempDir` | `agentChatLaunch(input)` | `env.TEMP === env.TMP === tempDir`; the `--config` overlay path is unchanged | `agentChatLaunch.test.ts` |
  | Every main source file | Scan for `writeOmpFiles(` calls passing `computer` | Exactly one caller, the desktop-control module | `desktopOverlayCallers.test.ts` |
- **Dependencies.** `dc-live-facts`.

### dc-owner: Own desktop control in main: single owner, enable with one native confirmation, never resumed on

- **Size** medium · **Reasoning** high
- **Outcome.** `src/main/desktopControl/desktopControl.ts` **(new)** holds the single owner
  `{folder, chatId, pid, since, phase}` (D §4).
  - **The enable channel.** `agentChat:setDesktopControl {folder, chatId, on}` is added to `AGENT_CHAT_CHANNELS`
    (`src/shared/agents/agentChat.ts:13`), registered in `src/main/agentChat/agentChatIpc.ts` beside `:240-251` through
    the guard, and exposed in `src/preload/index.ts`.
  - **Enable checks** (D §3.1, §3.3): an OMP GUI chat on the GUI surface, on Windows, with no other owner. Then one
    native confirmation (Cancel default, no Hello) built like `confirmYolo` (`src/main/desktop/bootstrap.ts:233-238`).
  - **The relaunch.** The chat's live process is force-stopped, and the chat relaunches on its same session through
    `startFiles` with `computer` (`dc-launch`). After `ready`, main requires `/computer status` → `Computer use:
    enabled` and the `get_state` marker (B:134-141). If either is missing, it ends control with
    `status-unconfirmed`.
  - **State.** The phase (`starting`, `active`, `ending`) is pushed to the renderer on the chat event push. A switch
    to the terminal surface is refused while the chat holds control.
  - **Never persisted.** Ownership is never written to the chat record, the restart marker or the session folder.
    Exit of the owner's process clears it.
  - **Placeholder kill.** This ticket ends control with a plain force stop; `dc-kill` replaces that with the one kill.
- **Source locations.**
  - `src/main/agentChat/agentChatSessions.ts`: `startFiles` `:802-813`, `stop` `:1138-1144`, `isLive` `:1191-1194`,
    and the surface switch near `:1099-1137`;
  - `src/main/agentChat/agentChatIpc.ts`, `src/shared/agents/agentChat.ts`, `src/preload/index.ts`;
  - `src/main/desktop/bootstrap.ts`, `src/main/agentChat/restartResume.ts`, `src/main/agentChat/agentChatWiring.ts`.
- **Tests.** `src/main/desktopControl/desktopControl.test.ts` **(new)**, `src/main/agentChat/agentChatIpc.test.ts`,
  `src/main/agentChat/agentChatSessions.test.ts`, `src/main/agentChat/restartResume.test.ts`,
  `src/preload/index.test.ts`.
- **Acceptance criteria.**
  - c1: An enable for an OMP GUI chat shows exactly one native confirmation. On confirm, it relaunches the same
    session with the computer overlay and reaches `active` only after both signatures. Cancel changes nothing.
  - c2: These enables are refused before any dialog: a Claude chat, a terminal-surface chat, a non-Windows platform,
    and a second chat while one owns control.
  - c3: Every later launch writes the default overlay and reports Off: a relaunch after control ended, a restart
    resume (`restartResume.ts`), a lazy resume on send, and, when `s6-repair-resume` has landed, a Techmarine boot
    resume.
  - c4: The renderer cannot pass argv, env, a path or config text. The channel's schema is a strict
    `{folder, chatId, on}`.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | An idle OMP GUI chat, no owner, fake omp answering the enabled signature | Enable; confirm the dialog | One dialog; a relaunch with `--resume <same id>`; the overlay has the computer block; phase `active` | `desktopControl.test.ts` with the `agentChatRig` |
  | Chat A owns control | Enable for chat B | Refused with `conflict` before any dialog; A is unchanged | `desktopControl.test.ts` |
  | Fake omp answers `Computer use: disabled` after `ready` | Enable and confirm | Control ends with `status-unconfirmed`; owner cleared | `desktopControl.test.ts` |
  | A Magos that held control, then a restart marker written for it | Run the restart resume | It relaunches with no computer block; the toggle is Off | `restartResume.test.ts` |
- **Dependencies.** `dc-launch`.

### dc-overlay: Draw the border and note on every display from main

- **Size** medium · **Reasoning** medium
- **Outcome.** `src/main/desktopControl/overlayWindows.ts` **(new)** creates one `BrowserWindow` per
  `screen.getAllDisplays()` entry. It uses exactly the probed options (O:69-80; `scripts/spike/desktop/overlay/overlay.electron.cjs:69-75`):
  - `transparent`, `frame: false`, `focusable: false`, `skipTaskbar`, not resizable, movable or fullscreenable,
    `hasShadow: false`;
  - `setIgnoreMouseEvents(true)`, `setAlwaysOnTop(true, 'screen-saver')`, `setContentProtection(true)`, and
    `showInactive()`.

  It re-asserts `screen-saver` plus `moveTop()` every 500 ms (`:155`), rebuilds on display add, remove and
  metrics-change (`:158`), and `close()` destroys every window synchronously.
  - **Page.** A static, script-free page under a strict CSP draws the 4 px `rgba(255,64,64,0.85)` border and the
    top-centre note "A Skitarii agent is controlling the desktop — press Esc to stop" (O:74-75).
  - **`windows.test.ts`.** `src/main/windows.test.ts:17-23` is updated **deliberately**: the allowed set becomes
    `index.ts` and `desktopControl/overlayWindows.ts`, with exactly one `new BrowserWindow` each. A new assertion pins
    the overlay's options.
- **Source locations.** `src/main/windows.test.ts`, `src/main/index.ts` (`:31`, the one existing window),
  `scripts/spike/desktop/overlay/overlay.electron.cjs`, `scripts/spike/desktop/windows.ps1`.
- **Tests.** `src/main/windows.test.ts`, `src/main/desktopControl/overlayWindows.test.ts` **(new)**, using a fake
  window factory and an injected timer.
- **Acceptance criteria.**
  - c1: Two fake displays give two windows, each at its display's bounds with the pinned options and content
    protection on. A `display-added` event gives a third. `close()` leaves zero.
  - c2: `windows.test.ts` passes, with the allowed set extended by exactly the overlay module and the overlay options
    asserted.
  - c3: On the host, the built app's overlay window is listed topmost above a fixture with affinity `0x11` (the
    `windows.ps1` window list). The e2e step in `dc-e2e` covers this.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | Fake `screen` with displays 1 and 2 | `open()` | Two windows at their bounds; click-through, non-focusable, `screen-saver`, protected | `overlayWindows.test.ts` |
  | Overlay open; the timer advances 500 ms | Tick | `setAlwaysOnTop('screen-saver')` and `moveTop()` on each window; never `focus()` | `overlayWindows.test.ts` |
  | Main sources at HEAD | Scan for `new BrowserWindow` | Exactly `index.ts` and `desktopControl/overlayWindows.ts`, one each | `windows.test.ts` |
- **Dependencies.** `dc-delivery`.

### dc-hook: Ship the physical-ESC hook helper with fail-closed liveness

- **Size** medium · **Reasoning** high
- **Outcome.** `src/main/desktopControl/escHook.ts` **(new)** bundles the `WH_KEYBOARD_LL` C# source the way
  `src/main/agentChat/windowsAgentJob.ts:3-4` bundles its supervisor: fixed source, never loaded from cwd. It starts it
  with `-ParentPid` (O:136-143; `scripts/spike/desktop/esc-hook.ps1`).
  - **Parsing.** It parses the helper's JSON lines and applies `shouldKill` (`scripts/spike/desktop/escDecision.mjs:18-21`,
    moved into `src/main/desktopControl/escDecision.ts` **(new)**): an Escape key-down with `injected === false` only.
  - **Watchdog.** It runs the watchdog: heartbeat gap > 1000 ms, ping gap > 2500 ms, or helper exit
    (O:151; `scripts/spike/desktop/overlay/control.mjs:26-27,197-198,218`).
  - **Privacy.** The helper logs only Escape and its own tagged keys (O:42-43).
  - **Exit order.** The helper **stops its ping thread before unhooking** (O:56-58; `esc-hook.ps1:120,129-132`).
- **Source locations.** `scripts/spike/desktop/esc-hook.ps1`, `scripts/spike/desktop/escDecision.mjs`,
  `scripts/spike/desktop/overlay/control.mjs`, `scripts/spike/desktop/inject.ps1`,
  `src/main/agentChat/windowsAgentJob.ts`.
- **Tests.**
  - `src/main/desktopControl/escDecision.test.ts` **(new)**, porting `scripts/spike/desktop/escDecision.test.mjs`;
  - `src/main/desktopControl/escHook.test.ts` **(new)**: the watchdog with an injected clock, and line parsing;
  - `src/main/desktopControl/escHook.real.test.ts` **(new)**: Windows-only. It starts the real helper, injects a tagged
    Escape with `SendInput` and expects `injected: true` with no kill, then kills the helper and expects `hook-exited`.
- **Acceptance criteria.**
  - c1: Only a non-injected Escape key-down decides a kill. Injected (including `lowerIl`), key-up, other keys and
    unknown provenance never do.
  - c2: With an injected clock, a heartbeat gap of 1001 ms decides `heartbeat-lost`, a ping gap of 2501 ms decides
    `ping-lost`, and helper exit decides `hook-exited`. Gaps of 999 ms and 2499 ms decide nothing.
  - c3: The helper source stops the ping thread before `UnhookWindowsHookEx`. On the host, the real test sees an
    injected Escape flagged injected, and helper death reported within 200 ms.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | Hook lines `{vk:27, injected:true, down:true}` and `{vk:27, injected:false, down:true}` | Decide each | No kill, then kill `physical-esc` | `escDecision.test.ts` |
  | Watchdog with a fake clock; last ping at t | Advance to t + 2501 ms | `ping-lost` | `escHook.test.ts` |
  | Real helper on the Windows host | `SendInput` a tagged Escape; then `taskkill /F` the helper | `injected: true`, no kill; then `hook-exited` | `escHook.real.test.ts` |
- **Dependencies.** `dc-delivery`.

### dc-kill: One kill for every path, within the stated bounds

- **Size** medium · **Reasoning** high
- **Outcome.** `endDesktopControl(reason)` in `desktopControl.ts` runs the fixed order of D §6.3:
  1. close the overlay windows synchronously;
  2. at the same moment, force-stop the owner's process (`AgentProcess.stop({ force: true })`,
     `src/main/agentChat/agentProcess.ts:206-211`). Never `interrupt` (`agentChatSessions.ts:1039-1058`), and never
     the 5 s graceful path first (`:250-256`);
  3. keep the hook listening for 1 s;
  4. on exit, clear the owner, lift the lock, stop the helper and push the state.

  It is wired to every path:
  - physical ESC and the watchdog (`dc-hook`);
  - header Stop (a `setDesktopControl {on:false}` call);
  - `stop` and `deleteChat` (`agentChatSessions.ts:1138-1156`);
  - `releaseFolder` (`:1163-1172`) and `endAgent` (`:1173-1175`);
  - `dispose` on quit (`:1176-1190`, `src/main/quitDisposal.ts:62`);
  - the owner process's own exit.

  On a DM crash, the overlay dies with the process. The helper's parent watch and the owned job's
  `KILL_ON_JOB_CLOSE` (`windowsAgentJob.ts:137`) end the rest (O:184-185); `dc-e2e`'s `desktop-crash` proves it. The
  overlay and hook are started before the computer-capable process launches.
- **Source locations.** `src/main/agentChat/agentChatSessions.ts`, `src/main/agentChat/agentProcess.ts`,
  `src/main/agents/processTree.ts` (`:247`), `src/main/quitDisposal.ts`, `src/main/agentChat/agentChatWiring.ts`,
  `src/main/desktop/handlers.ts` (`untrackFolder` `:190`).
- **Tests.** `src/main/desktopControl/desktopControl.test.ts`, `src/main/agentChat/agentChatSessions.test.ts`,
  `src/main/quitDisposal.test.ts`, `src/main/agentChat/agentChatWiring.test.ts`.
- **Acceptance criteria.**
  - c1: Each of the 12 reasons calls one kill. In every case the overlay `close` is called before or with the force
    stop, and never after an `interrupt`.
  - c2: The owner, the lock and the hook are released only after the process `exit`. An approval command sent
    between the kill and the exit is still refused.
  - c3: With fake timers, the kill is never delayed by the 5 s bounded shutdown. The host timings are asserted in
    `dc-e2e` (overlay ≤ 10 ms, tree ≤ 150 ms).
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | Chat A owns control; a fake process that exits 120 ms after a force stop | Fire each reason in turn | Overlay closed, force stop issued, owner cleared only after exit; `reason` recorded | `desktopControl.test.ts` |
  | Chat A owns control | Untrack A's folder | The kill runs before `forget`; the untrack completes | `agentChatSessions.test.ts` |
  | Control active | `before-quit` | The kill runs first; quit completes inside 5 s | `quitDisposal.test.ts` |
- **Dependencies.** `dc-owner`, `dc-overlay`, `dc-hook`.

### dc-lock-main: Lock DM's human-only controls in main while desktop control is active

- **Size** medium · **Reasoning** high
- **Outcome.** `desktopControl.locked()` is enforced at three choke points (D §5.6):
  1. **The sender guard.** `guardIpc` (`src/main/ipcGuard.ts:64-75`) gains `locked(channel, args)`, and a locked call
     returns `{ ok: false, error: { code: 'desktop_control_active' } }` without running the handler. The locked
     channels are:
     - `dm:approveLearningCard` (`src/main/desktop/learningApprovalIpc.ts:30`);
     - `chats:kickBackKanbanCard` and `chats:startKanbanCard` (`src/main/agents/chatIpc.ts:18-19`);
     - `browser:decideOrigin` when the decision is not `deny` (`src/main/browser/browserIpc.ts:261`;
       `src/shared/browser/browserApi.ts:29-31`);
     - `browser:setEnabled` when enabling (`browserIpc.ts:267`);
     - `corrections:createCrossRepo` (`src/main/desktop/crossRepoCorrections.ts:519`).
  2. **Human-only commands.** `runCommand` (`src/main/desktop/handlers.ts:150-163`) refuses any command whose
     `COMMAND_CAPABILITIES` entry (`src/core/commands/capabilities.ts:25`) is in `HUMAN_ONLY_CAPABILITIES`
     (`src/core/authz.ts:95-131`). This covers checkpoint approve, approve-and-advance and redraft approval, the
     delivery waiver, retry grants, Kanban approve, kick-back, delete and play, grants, deletes and the rest.
  3. **Native confirmations.** `confirmInstall`, `confirmYolo`, `confirmCustomAgent` and `confirmNotificationSettings`
     (`src/main/desktop/bootstrap.ts:226-290`), and the desktop-control enable, return "not confirmed" without showing
     a dialog.

  `desktop_control_active` joins `DOMAIN_ERROR_CODES` (`src/shared/domain/errors.ts:5`). Stop, chat stop, reading,
  sending and browser Deny stay available. **Optional criterion c4**, the orchestrator's open question in D §5.6, is
  saved only if the person agrees at the checkpoint.
- **Source locations.** `src/main/ipcGuard.ts`, `src/main/desktop/handlers.ts`, `src/main/desktop/bootstrap.ts`,
  `src/shared/domain/errors.ts`, `src/core/authz.ts`, `src/core/commands/capabilities.ts`,
  `src/main/agentChat/agentChatIpc.ts` (`:244`, for c4).
- **Tests.** `src/main/ipcGuard.test.ts`, `src/main/desktop/handlers.test.ts`, `src/main/desktop/bootstrap.test.ts`,
  `src/main/desktop/settingsIpc.test.ts`, `src/main/desktop/yoloHandlers.test.ts`, `src/main/browser/browserIpc.test.ts`.
- **Acceptance criteria.**
  - c1: While locked, every desktop command whose capability is human-only is refused with `desktop_control_active`,
    and its service is never called. The test iterates `COMMAND_CAPABILITIES`, so a new human-only command is covered
    without editing the test. Non-human-only commands still run.
  - c2: While locked, each locked channel is refused before its handler: site Allow refused, Deny allowed, enabling the
    browser refused. Each listed native confirmation returns false without opening a dialog. When unlocked, all behave
    as before.
  - c3: The lock is lifted only after the owner's process has exited (`dc-kill` c2), and Stop is never locked.
  - c4 (optional, person's decision): `agentChat:answer` with an approving answer is refused while locked; Deny and
    question answers are allowed.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | Desktop control active | `dm:command` `approveAndAdvance`, `grantRetry`, `deleteKanbanCard` | Each `{ok:false, code:'desktop_control_active'}`; the workspace is never called | `handlers.test.ts` |
  | Desktop control active | `browser:decideOrigin` `once`, then `deny` | The first refused by the guard; the second reaches the handler | `ipcGuard.test.ts`, `browserIpc.test.ts` |
  | Desktop control active | A loosening `settings:setNotifications` | `confirmNotificationSettings` returns false without a dialog; the change is not saved | `bootstrap.test.ts`, `settingsIpc.test.ts` |
  | Control ended (owner exited) | `approveAndAdvance` | Runs normally | `handlers.test.ts` |
- **Dependencies.** `dc-owner`.

### dc-lock-ui: Show the lock on every human-only control in the window

- **Size** small · **Reasoning** medium
- **Outcome.** Each component of D §5.6's table reads the pushed `desktopControl` state. While control is active it
  disables its control and shows "Locked while desktop control is on: press Esc or Stop first". The components are:
  - `CheckpointScreen.tsx` `GateActions` (`:403-416`) and `EpicWorkspace.tsx` (`:136`);
  - `KanbanCardPanel.tsx` (`:246`, `:250`, `:304`), `DeleteCardControl.tsx` (`:39`) and `StartCardDialog.tsx` (`:40`);
  - `OriginPromptCard.tsx` Allow (`:72`; Deny stays enabled);
  - `NotificationSettings.tsx` (`:100`, loosening only) and `GrantsCard.tsx` YOLO (`:151`).

  A `desktop_control_active` refusal from main shows the same note, for the case where the push arrived late.
  Presentation only: main enforces (`dc-lock-main`).
- **Source locations.** `src/renderer/src/checkpoint/CheckpointScreen.tsx`, `src/renderer/src/epic/EpicWorkspace.tsx`,
  `src/renderer/src/kanban/KanbanCardPanel.tsx`, `src/renderer/src/kanban/DeleteCardControl.tsx`,
  `src/renderer/src/kanban/StartCardDialog.tsx`, `src/renderer/src/browser/OriginPromptCard.tsx`,
  `src/renderer/src/settings/NotificationSettings.tsx`, `src/renderer/src/home/GrantsCard.tsx`,
  `scripts/capture-agent-chat.mjs` (`STATES` `:22-39`).
- **Tests.** `src/renderer/src/checkpoint/CheckpointScreen.test.tsx`, `src/renderer/src/kanban/KanbanCardPanel.test.tsx`,
  `src/renderer/src/browser/OriginPromptCard.test.tsx`, `src/renderer/src/settings/NotificationSettings.test.tsx`,
  `src/renderer/src/home/GrantsCard.test.tsx`, `scripts/capture-agent-chat.test.mjs`.
- **Acceptance criteria.**
  - c1: With the state active, each listed control is disabled with the note, and Deny and Stop stay enabled. With the
    state off, all are enabled.
  - c2: New capture states `desktop-locked-checkpoint`, `desktop-locked-kanban` and `desktop-locked-origin`, at
    1024×768 and 1440×900, are attached and inspected.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | A gate with Approve enabled; desktop control pushed active | Render `CheckpointScreen` | Approve and the retry buttons disabled; the note shown | `CheckpointScreen.test.tsx` |
  | An origin prompt; control active | Render `OriginPromptCard` | Allow once and Always disabled; Deny enabled | `OriginPromptCard.test.tsx` |
  | Capture harness | Run the three new states at both sizes | PNGs show the disabled controls and the note | The reviewer opens the attached PNGs |
- **Dependencies.** `dc-lock-main`.

### dc-never-arbitrate: Register the desktop never_arbitrate predicate

- **Size** small · **Reasoning** medium
- **Outcome.** `wireAgentChats` (`src/main/agentChat/agentChatWiring.ts:135-175`) registers a `desktopControlPrompt`
  predicate through `registerNeverArbitrate` (`src/main/magos/arbitrationRules.ts:95-101`), beside
  `browserToolApproval` (`:128-137`), and unregisters it in `dispose` (`:171`). It reads `ArbitrationInput`
  (`arbitrationRules.ts:25-41`) and returns true when:
  - `input.chat` is the desktop-control owner (any thread of it); or
  - `input.prompt` concerns computer use: an `eval` tool whose `input.code` matches `\bcomputer\s*\.`, a tool name
    starting `computer`, or a title or detail naming `computer.control` (B:122-131).

  `registeredExclusion` (`arbitrationRules.ts:150-159`) then gives `never_arbitrate`, and the prompt goes to the person.
- **Source locations.** `src/main/agentChat/agentChatWiring.ts`, `src/main/magos/arbitrationRules.ts`,
  `src/main/agentChat/promptArbitration.ts` (`:94-116`).
- **Tests.** `src/main/agentChat/agentChatWiring.test.ts`, `src/main/magos/arbitrationRules.test.ts`.
- **Acceptance criteria.**
  - c1: With `agentKind: 'claude'`, an orchestrator chat with a `runId` and a folder (so no earlier rule excludes),
    a prompt whose tool is `eval` with `computer.click(…)` in its code gives `{reason: 'never_arbitrate'}`. The same
    prompt without `computer.` is not excluded by this predicate.
  - c2: Any prompt of the chat that owns desktop control gives `never_arbitrate`. After control ends, it no longer
    does. A predicate that throws excludes. After `dispose`, the predicate is unregistered.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | A Claude-kind Magos chat; an `eval` prompt with `computer.screenshot()` | `arbitrationExclusion(input)` | `{reason:'never_arbitrate'}` | `arbitrationRules.test.ts` with the predicate registered |
  | Chat A owns control; a plain `Bash` prompt from A | Arbitrate through `wireAgentChats` | Escalated to the person with the never-arbitrate text; no arbiter started | `agentChatWiring.test.ts` |
- **Dependencies.** `dc-owner`.

### dc-ui: Header toggle, badge and Stop, tree-row lock, and the end notification

- **Size** medium · **Reasoning** medium
- **Outcome.**
  - **Header.** `ChatHeader` (`src/renderer/src/agentChat/AgentChat.tsx:217-237`) gets a **Desktop control** toggle
    (OMP GUI chats on Windows only, Off by default). While control is active it shows a light red badge "Desktop
    control on" (`role="status"`) and a **Stop desktop control** button. A "Starting desktop control" state and an
    "Ended: <reason>" line come from the pushed state.
  - **Tree.** `TreeRow` (`src/renderer/src/agentTree/AgentTree.tsx:190`) shows a lock glyph named "Desktop control on"
    on the owner's root row.
  - **Notification.** `NOTIFICATION_EVENTS` (`src/shared/desktop/notificationSettings.ts:10`) gains `desktop_control`,
    on by default. Main raises it with a needs-you item only for a fail-closed or external end (D §5.4); the person's
    own toggles raise nothing.
  - **Captures.** States `desktop-header-off`, `desktop-header-starting`, `desktop-header-on`, `desktop-header-ended`
    and `desktop-tree-lock`, at 1024×768 and 1440×900.
- **Source locations.** `src/renderer/src/agentChat/AgentChat.tsx`, `src/renderer/src/agentChat/useAgentChat.ts`,
  `src/renderer/src/agentTree/AgentTree.tsx`, `src/renderer/src/agentTree/agentTree.css`,
  `src/shared/desktop/notificationSettings.ts`, `src/main/notify/notifier.ts`, `src/main/agentChat/agentChatWiring.ts`,
  `scripts/capture-agent-chat.mjs`.
- **Tests.** `src/renderer/src/agentChat/AgentChat.test.tsx`, `src/renderer/src/agentTree/AgentTree.test.tsx`,
  `src/main/notify/notifier.test.ts`, `src/main/agentChat/agentChatWiring.test.ts`, `scripts/capture-agent-chat.test.mjs`.
- **Acceptance criteria.**
  - c1: The toggle shows only for an OMP GUI chat. The badge and Stop show only while the pushed state is active, and
    Stop calls `setDesktopControl {on:false}`.
  - c2: The owner's tree row shows the lock and no other row does. A `hook-exited` end raises one `desktop_control`
    notification and a needs-you item; a person's Stop raises none.
  - c3: The five capture states at both sizes are attached and inspected. The badge text keeps ≥ 4.5:1 contrast on
    the glass header.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | An OMP GUI chat; state off | Render the header | "Desktop control: Off" toggle; no badge | `AgentChat.test.tsx` |
  | State active for the chat | Render; click Stop | Badge "Desktop control on"; `setDesktopControl` called with `on:false` | `AgentChat.test.tsx` |
  | Control ended with `heartbeat-lost` | Main handles the end | One `desktop_control` notification and a needs-you item on the chat | `agentChatWiring.test.ts`, `notifier.test.ts` |
- **Dependencies.** `dc-owner`.

### dc-screens: Desktop screenshots inline, and no screenshot left behind

- **Size** medium · **Reasoning** medium
- **Outcome.**
  - **Ingest.** While a chat owns control, main watches its `computer` folder (the `TEMP` from `dc-launch`). Each new
    `omp-computer-*.png` is stored with `putToolImage` (`src/main/agentChat/chatImages.ts:98`, which runs the intake at
    `src/core/attachments/intake.ts:198`) as a tool image of the running `eval` item. It is capped like other tool
    images (8 per item, `src/main/agentChat/toolResultImages.ts:16`), so it renders inline through the S3 chat-image
    path (D §5.7, B:56).
  - **Fallback.** If `dc-live-facts` disproved the `TEMP` route, main instead collects `%TEMP%\omp-computer-*.png`
    created within the owner's session window.
  - **Cleanup.** When control ends, the folder is deleted (B:175-177).
- **Source locations.** `src/main/agentChat/chatImages.ts`, `src/main/agentChat/toolResultImages.ts`,
  `src/main/agentChat/agentChatSessions.ts` (`storeToolImages`, near `:683`), `src/main/desktopControl/desktopControl.ts`.
- **Tests.** `src/main/desktopControl/desktopScreens.test.ts` **(new)**, `src/main/agentChat/chatImages.test.ts`.
- **Acceptance criteria.**
  - c1: A PNG written into the owner's folder during an `eval` turn becomes that item's tool image (by id only), and
    a non-image or oversize file is dropped by the intake.
  - c2: After every kill reason, the folder and its PNGs are gone, and no `omp-computer-*.png` from the session
    remains in the real `%TEMP%`.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | Owner active; a running `eval` item | Write `omp-computer-1.png` into the folder | One tool image on that item; the transcript holds its id only | `desktopScreens.test.ts` |
  | Owner active with two PNGs in the folder | End control (`stop`) | Folder deleted | `desktopScreens.test.ts` |
- **Dependencies.** `dc-live-facts`, `dc-kill`.

### dc-e2e: Prove desktop control end to end with a fake computer-use persona and a fixture window

- **Size** large · **Reasoning** high
- **Outcome.**
  - **Fake persona.** `src/main/agentChat/__fixtures__/fakeAgentCli.mjs` gains an OMP computer-use persona, beside
    `FAKE_AGENT_PERSONA` (`:26-29`), built from `docs/reports/desktop-control-backend/omp-computer-use.rpc.redacted.jsonl`
    (B:148-155). It:
    - answers `/computer status` and `get_state` per its real `--config` file (B:136-137);
    - replays the `eval` frames;
    - drives the fixture through `SendInput` (click, "hello" and an **injected** Escape, after a foreground check);
    - writes one `omp-computer-1.png` into its `TEMP`.
  - **Fixture.** `scripts/spike/desktop/fixture.electron.cjs` is promoted to `scripts/desktop-fixture.electron.cjs`
    **(new)**.
  - **Steps.** `scripts/e2e-agent-chat.mjs` gains steps beside `STEPS` (`:3822-3874`), each with its own deadline,
    zero retries, and only fixture windows it launched:
    - `desktop-enable`, `desktop-drive` and `desktop-injected-esc`;
    - `desktop-lock`, `desktop-stop` and `desktop-failclosed`;
    - `desktop-single-owner`, `desktop-untrack`, `desktop-quit` and `desktop-crash`;
    - `desktop-restart-off`.

    The steps measure the overlay-gone and tree-ended times, from the window list and the pid.
  - **Live smoke.** `scripts/desktop-live-smoke.mjs` **(new)**: real omp, at most 5 minutes and $0.50, run once at
    acceptance.
- **Source locations.** `scripts/e2e-agent-chat.mjs`, `scripts/e2e-agent-chat.test.mjs`,
  `src/main/agentChat/__fixtures__/fakeAgentCli.mjs`, `src/main/agentChat/fakeAgentCli.test.ts`,
  `scripts/spike/desktop/fixture.electron.cjs`, `scripts/spike/desktop/inject.ps1`, `scripts/spike/desktop/windows.ps1`,
  `scripts/spike/desktop/foreground.ps1`, `docs/reports/desktop-control-backend/omp-computer-use.rpc.redacted.jsonl`.
- **Tests.** `src/main/agentChat/fakeAgentCli.test.ts`, `scripts/e2e-agent-chat.test.mjs`. The steps run against the
  built app on the host.
- **Acceptance criteria.**
  - c1: `desktop-enable` through `desktop-stop`, run against the built app with zero retries, show all of these:
    - the overlay topmost with affinity `0x11`;
    - the fixture reading back clicks, "hello" and `Escape` (`isTrusted: true`), with control still on after the
      injected ESC;
    - locked controls refused with `desktop_control_active`;
    - Stop giving overlay gone ≤ 10 ms and tree ended ≤ 150 ms after the kill decision, with 0 injected keys after.
  - c2: `desktop-failclosed`, `desktop-untrack`, `desktop-quit` and `desktop-crash` each end control within its bound
    from D §6.2 (`taskkill /F` of DM main leaves no OMP pid, helper or overlay after 1 s). `desktop-single-owner` and
    `desktop-restart-off` pass.
  - c3: The live smoke with real omp drives the fixture and is ended by Stop. No `omp-computer-*.png` remains, and
    the global OMP config hash is unchanged.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | Built app, isolated profile, fake computer persona, fixture launched | Run `desktop-enable desktop-drive desktop-injected-esc desktop-stop` | Each step `ok`; timings within bound; 0 keys after the tree ended | The e2e JSON verdict plus the window-list and fixture-state records |
  | Control active in the built app | `taskkill /F` the DM main pid (`desktop-crash`) | Within 1 s: no OMP pid, no helper, no overlay window | The e2e JSON verdict |
  | Real omp signed in | Run `desktop-live-smoke.mjs` | Fixture `clicks≥1 text="hello"`, Stop ends control, `%TEMP%` clean, config hash unchanged | The smoke record attached to the acceptance |
- **Dependencies.** `dc-kill`, `dc-lock-ui`, `dc-never-arbitrate`, `dc-ui`, `dc-screens`.

### dc-docs: Document desktop control as built

- **Size** small · **Reasoning** medium
- **Outcome.**
  - `docs/design/desktop-control.md` is updated to as-built: each UNPROVEN item of its §10 is marked proven, with the
    ticket and evidence, or still UNPROVEN.
  - A decision record, `docs/decisions/0010-desktop-control.md` **(new)**, sits next to `0009-agent-browser.md`.
  - The user guide's agents runbook (`docs/runbooks/agents.md`) gains a "Desktop control" section: what it does, the
    border, ESC and Stop, the lock, the limits of D §7, and the risk the person accepted.
  - `docs/architecture.md` names the desktop-control module and the lock.
- **Source locations.** `docs/design/desktop-control.md`, `docs/decisions/0009-agent-browser.md`,
  `docs/runbooks/agents.md`, `docs/architecture.md`.
- **Tests.** `npx vitest run src/core/space/rubric.docs.test.ts`, which reads `docs/architecture.md`.
- **Acceptance criteria.**
  - c1: The design's §10 list has a verdict for every item, each with its evidence.
  - c2: The runbook section states the per-chat enable, the border and note, physical ESC and Stop, the human-only
    lock, and the elevated-window, fullscreen and secure-desktop limits.
- **testCases.**

  | startingCondition | action | expectedResult | verificationMethod |
  | --- | --- | --- | --- |
  | All implementation tickets accepted | Update the docs | Every UNPROVEN item has a verdict; the runbook section exists | The reviewer reads the docs against the evidence; `rubric.docs.test.ts` passes |
- **Dependencies.** `dc-e2e`.

### dc-acceptance: Desktop-control build sprint acceptance

- **Kind** acceptance · **Reasoning** multi_step
- **Body.**
  1. Run the Definition of Done once: lint, typecheck, test, coverage, deadcode and build.
  2. Run the `desktop-*` e2e steps and the new capture states at both sizes.
  3. Run the live smoke.
  4. Open and attach every PNG and verdict.
  5. Check each covering criterion.

  Before submitting the human checkpoint, deliver the sprint to `main` by protected pull request, own CI Checks →
  Deploy, and record the release and the packaged journey from `deploymentVerification`. The person alone approves and
  controls any live-host Restart now.
- **Acceptance criteria** (each `covers` one ticket):

  | id | covers | text |
  | --- | --- | --- |
  | c1 | `dc-delivery` | The delivery-check evidence names the previous sprint's merge on `origin/main`, its release or recorded Deploy skip (no-release case: no restart expected), the installed app version and the resumed Magos |
  | c2 | `dc-live-facts` | `docs/reports/desktop-control-live-facts.md` gives verdicts on the `TEMP` route, resume-with-default-overlay and kill timing within 30 min and $1, with the global config unchanged |
  | c3 | `dc-launch` | `npx vitest run src/main/terminals/ompSession.test.ts src/main/agentChat/agentChatLaunch.test.ts src/main/agentChat/desktopOverlayCallers.test.ts` passes |
  | c4 | `dc-owner` | `npx vitest run src/main/desktopControl/desktopControl.test.ts src/main/agentChat/restartResume.test.ts` passes; the e2e `desktop-single-owner` and `desktop-restart-off` steps pass |
  | c5 | `dc-overlay` | `npx vitest run src/main/windows.test.ts src/main/desktopControl/overlayWindows.test.ts` passes, with `windows.test.ts` updated deliberately; `desktop-enable` shows the overlay topmost with affinity `0x11` |
  | c6 | `dc-hook` | `npx vitest run src/main/desktopControl/escDecision.test.ts src/main/desktopControl/escHook.test.ts src/main/desktopControl/escHook.real.test.ts` passes on the host |
  | c7 | `dc-kill` | Every kill reason is unit-tested, and the e2e timings show overlay ≤ 10 ms and tree ≤ 150 ms with 0 keys after |
  | c8 | `dc-lock-main` | `npx vitest run src/main/ipcGuard.test.ts src/main/desktop/handlers.test.ts src/main/desktop/bootstrap.test.ts` passes, including the `COMMAND_CAPABILITIES` sweep; `desktop-lock` shows the refusals in the built app |
  | c9 | `dc-lock-ui` | The locked-control capture states are attached and inspected, and the renderer tests pass |
  | c10 | `dc-never-arbitrate` | `npx vitest run src/main/magos/arbitrationRules.test.ts src/main/agentChat/agentChatWiring.test.ts` passes with the desktop predicate cases |
  | c11 | `dc-ui` | The header and tree capture states are attached and inspected; the notification tests pass |
  | c12 | `dc-screens` | `desktopScreens.test.ts` passes; the live smoke leaves no `omp-computer-*.png` |
  | c13 | `dc-e2e` | All `desktop-*` e2e steps pass with zero retries, and the live smoke passes; verdicts attached |
  | c14 | `dc-docs` | The as-built docs are merged. If this sprint is the final sprint, the report's `epicOutcome` reports s7–s16 with evidence, s12 met by this sprint; otherwise the report states that a later sprint follows and carries no `epicOutcome` |

## How each UNPROVEN item is settled

| UNPROVEN item (source) | Settled by |
| --- | --- |
| The physical ESC press and its timing; OMP and DM stops together (O:256-257, B:234-235) | The person's single checkpoint step (`deploymentVerification`). The DM side is asserted by `escHook.real.test.ts` (injected) and the `dc-hook` decision tests |
| RDP visibility of the content-protected overlay (O:128-129, O:265) | The same checkpoint step, on the product's protected overlay |
| OMP honours `TEMP` for `omp-computer-*.png` (D §5.7) | `dc-live-facts` fact 1; the fallback is in `dc-screens` |
| A resumed session with the default overlay is disabled (D §3.4) | `dc-live-facts` fact 2; `dc-owner` c3 pins the invariant |
| Inline desktop screenshots (B:56) | `dc-screens` c1 and `dc-e2e` |
| DM crash → OMP tree ended for real omp (O:184-185 [INFERENCE]) | `dc-e2e` `desktop-crash` |
| The Stop IPC hop | `dc-e2e` `desktop-stop` timings |
| Ping-loss detection (O:151) | `dc-hook` c2 (injected clock) |
| Held control (`tools.approval: computer.control`) needed? (B:122-124, B:237-238) | Retired by decision: per-call takeover covered every action (B:124). `dc-launch` c1 pins that no `tools.approval` is written, and the live smoke shows the drive works without it |
| The extra `Unidentified` keydown (B:89-90) | Stays a known oddity. `desktop-drive` asserts the text is unchanged |
| Multi-monitor, add/remove and DPI (O:264, B:241) | `overlayWindows.test.ts` covers the rebuild logic. On one monitor the host behaviour stays UNPROVEN, so it is a documented limit, not a gate |
| Elevated windows (UIPI) and exclusive fullscreen (O:258-262) | Not agent-testable (it needs a UAC prompt, or such an app). They stay documented limits (D §7) and are stated in the runbook by `dc-docs` |
| The piped-stdin oddity (O:266) | Moot: the overlay is in-process (D §5.1) |
| agent-desktop on non-Chromium apps (B:207-208, B:239-240) | Moot: agent-desktop is not used |
