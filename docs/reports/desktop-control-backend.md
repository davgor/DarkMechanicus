# Desktop-control backend probe (DM-1041)

Which backend gives a Skitarii GUI chat Codex-level total control of the whole desktop on the person's Windows host,
verifiably and unattended? This report records a bounded probe of the three candidates in the order the ticket gives.
It is evidence for the Sprint 5 design (`docs/design/desktop-control.md`) and the Sprint 6 proposal. It changes no
product code.

**Answer: candidate A, OMP's built-in computer use, is GO.** Turn it on per chat with `computer.enabled: true` in the
`--config` overlay DM already writes for each OMP chat. Candidate B (agent-desktop v1.3.1) is NO-GO as the primary
backend: its UI-tree read of an Electron window never completed. Candidate C (a DM-owned UIA helper) was not needed and
was not built; one in-box UIA read was run as a diagnostic only.

## Time box, global config and host

| Item | Value |
| --- | --- |
| Preparation (before the clock): worktree, `npm ci`, `omp --help` and docs reads, agent-desktop download and checksums, harnesses, fixture smoke test | 2026-11-28T17:33Z to 17:40Z |
| Observation clock **start** (after the drawn-desktop check passed) | **2026-11-28T17:40:13Z** |
| Last observation (the `omp-computer-off.mjs` negative control) | 2026-11-28T17:52:39Z |
| Observation clock **end** | **2026-11-28T17:52:52Z**, so **12 min 39 s** of the 90-minute hard limit |
| `sha256` of `~/.omp/agent/config.yml`, before | `400ac657f93da433140cccc47bdeb3c4e79a39a4394e08069ac2e052d647cc37` |
| `sha256` of `~/.omp/agent/config.yml`, after (17:51:19Z and again at 17:52:52Z) | `400ac657f93da433140cccc47bdeb3c4e79a39a4394e08069ac2e052d647cc37` (unchanged) |
| `sha256` of `omp config list --scope=global --json`, before and after | `69250f32…5883ec437` both times; `omp config get computer.enabled` still prints `false` afterwards |
| Host | Windows 11 `10.0.26200.9974`, driven over RDP (session 2, user davgo), one monitor `\\.\DISPLAY65` 2560×1600 physical at 150 % scaling (virtual screen 0,0 2560×1600) |
| Drawn-desktop check (`screen.ps1`, GDI `CopyFromScreen`, 70×44 sample grid) | `result: ok`, `nonBlack: 3080` of 3080 samples at 17:37:29Z and again at 17:40:13Z, so the desktop was drawn |
| Smart App Control | `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` `VerifiedAndReputablePolicyState = 0x0` (off); nothing was changed |
| PowerShell language mode | `FullLanguage` |
| omp | `omp/18.20.2` at `%LOCALAPPDATA%\omp\omp.exe` |
| Blender | Not installed (no `Program Files\Blender Foundation`, no `blender` on PATH, no `HKLM\SOFTWARE\BlenderFoundation`, no `.blend` file association). Observation 6 does not apply; nothing was installed. |

### Fixture

Every action targeted one window the probe launched: `scripts/spike/desktop/fixture.electron.cjs`, run with the repo's
Electron in a temporary profile. It shows a 562×342 DIP window (844×514 physical at 150 %, visible frame 824×503)
titled `DM-1041 fixture <A|B>`, with a "Probe button" and a "Probe input" field. It raises itself with
`setAlwaysOnTop(true, 'screen-saver')`, `moveTop()`, `show()` and `focus()`, and re-asserts that 0.5 s, 1.5 s and 3 s
after it is shown, so the person's always-on-top Dark Mechanicus window cannot cover it. It writes every click, the
field's text and every `keydown` (with `isTrusted`) to a state file the probes read back. The window was in front for
every action. In the recorded B run (b9), every `--headed` keystroke and the mouse click came right after a
`GetForegroundWindow` check (`foreground.ps1`) that returned the fixture's own HWND and PID. The one exception is the
headless `press escape`, which had no check of its own. The checks just before it (before `press o`) and just after it
(before the headed Escape) both matched the fixture, and its Escape reached the fixture. `agent-desktop-probe.mjs` now
checks before the headless press as well, but that change came after the recorded run. The cropped captures below
show the fixture on top.

### Privacy of evidence

- Whole-desktop captures were kept only as numbers (resolution, monitor layout, timings). Each PNG was deleted as soon
  as its crop to the fixture's visible frame was written. OMP's own desktop screenshots were taken with
  `{ silent: true }`, so the model never saw them. Note that OMP leaves every computer screenshot in `%TEMP%` as
  `omp-computer-*.png`. In run a2 the harness deleted the two that run wrote (`removedOmpScreenshots` in
  `omp-computer-probe.json`). Run a1 came before that cleanup existed, so its two files were deleted by hand right after
  the run.
- The committed RPC fixture went through `omp-transcript.mjs` `redact()`: image payloads become
  `<image:redacted-by-dm1041>`, tokens and keys are masked, and the home and temp folders become `<HOME>` / `<TMP>`.
  This run's stream carried no image payload: the tool-result images reached the model but were not echoed on stdout.
  A per-frame grep of the first commit missed one temp path the model streamed across two text deltas (`C:\Users\dav` +
  `go\AppData\…`). `redactDeltaStreams()` in `omp-transcript.mjs` now joins each stream's deltas before matching, the
  committed fixture was re-redacted with it (the path is now `<TMP>`), and the user name no longer appears in the file
  or in any joined delta stream.
- Attached screenshots are the fixture window only: agent-desktop's own window capture, or a desktop capture cropped to
  the fixture's visible frame. The crop drops the 10 px invisible resize border on each side and 11 px at the bottom,
  measured against agent-desktop's window capture of the same window.

## Candidate × observation

Latencies are wall time per operation on this host. For B, each one includes starting the `agent-desktop.exe` process.
For A, each is the in-process time the agent measured with `Date.now()` inside one `eval` cell (`stepMs`), from runs
a1 and a2.

| Observation | A: OMP computer use | B: agent-desktop v1.3.1 | C: DM-owned UIA helper |
| --- | --- | --- | --- |
| 1. Whole-desktop screenshot, every monitor | ✅ `await computer.display("all"); await computer.screenshot({ silent: true })` → `1280×800` (source 2560×1600 scaled down to the 1280×896 cap OMP applies to Claude models), **129 ms / 202 ms**. `computer.displays()` → one display, `scale: 1.5`, `pixelWidth: 2560`. | ✅ `screenshot --screen 0 <png>` → full 2560×1600, **306–437 ms** across 5 runs; `list-displays` 28–33 ms. Crop: im_B_DESKTOP. | Not run (A is GO). For reference, GDI `CopyFromScreen` of the virtual screen in a DPI-aware PowerShell takes 47–77 ms to capture and 146–185 ms to capture and save. |
| 2. Click a button and type text, then read back | ✅ AX `btn.press()` **85 / 91 ms**; `field.type("hello")` **144 / 156 ms**; pixel `win.click(154, 192)` on a fresh window screenshot **208 / 219 ms**. Fixture read back `clicks=2`, `text="hello"` in both runs. Chromium needs the foreground route: OMP reran type, click and press in takeover and said so (see below). Screenshot: im_A_AFTER. | ⚠️ Only by coordinates. `click <ref>` / `type <ref>` were impossible because no ref could be produced (row 3). `--headed mouse-click --xy 1025,701` (button centre from the in-box UIA read, checked inside the fixture) **84–117 ms** → `clicks=1`; `--headed press h` … `o` **98–628 ms each** → `text="hello"`. Screenshots: im_B_BEFORE, im_B_AFTER. | Not run. |
| 3. UI tree / accessibility snapshot | ✅ `win.ax()` **99 / 110 ms**, **23** `[ref=]` nodes, "Probe button" and "Probe input" both found; `win.find({ role: "button", title: "Probe button" })` returned exactly one element. | ❌ `snapshot --window-id <id>` timed out every time: at the 3 s default, and at 8, 15, 25 and 30 s, with `--max-depth` 25/30/40, with `-i --compact`, by `--app electron.exe`, and with the fixture started with `--force-renderer-accessibility`. It ended `TIMEOUT` or `ACTION_FAILED` "The Chromium tree is still thin after its accessibility build settled". `find --role button --name "Probe button"` also timed out at 20 s. `--skeleton` works (**7.8 s**, 14 nodes, 2 refs), but its refs are refused with `AMBIGUOUS_TARGET` (`identity_not_unique`, "the window could not be read whole"). | Diagnostic only: `uia-tree.ps1` (.NET `UIAutomationClient`, ControlView walk) read the same window in **104–144 ms**: 17 nodes, `ControlType.Button` "Probe button" at 908,667 233×68 and `ControlType.Edit` "Probe input" at 1038,758 505×56. |
| 4. Inject ESC into the fixture | ✅ `win.press("escape")` **50 / 52 ms**, delivered in takeover; the fixture logged `Escape` (`isTrusted: true`). The session went on and finished normally: an injected Escape did not trip OMP's physical-Esc stop. | ✅ `press escape --window-id <id>` headless **111–117 ms** and `--headed` **94–615 ms**; the fixture logged both (`isTrusted: true`). Headless `press` writes to the foreground queue, so it works only while the target is in front. | Not run. |
| 5. Per-operation latency | Above. Whole session from launch to settled: **25.6 s** (a1) and **23.1 s** (a2), one `eval` call, about **$0.08** of model spend per run (`usage.cost.total` 0.036 + 0.042 in a2). | Above. Process start-up dominates (`version` 29–35 ms). `list-windows` ~550 ms; window screenshot 743–809 ms. | — |
| 6. Blender | N/A: not installed. | N/A | N/A |
| 7. Driven from a Skitarii GUI chat over `rpc-ui` | ✅ Runs a1 and a2 (redacted transcript committed, see below). | Not applicable: agent-desktop is a CLI or MCP tool, not a chat. | — |
| 8. Coordinates inside the fixture | ✅ The one pixel call was `win.click(x, y)` with `(154, 192)` in the window's own screenshot frame (815×503): inside it. On the desktop, the window origin 869,509 plus the point is ≈1023–1025, 701, inside the fixture's physical bounds 860,509 844×514 (`coordinates` in `omp-computer-probe.json`). Every other action used an AX element of the fixture window, found by title. | ✅ The one coordinate, `1025,701`, is inside 860,509 844×514 (`targets` in `agent-desktop-probe.json`). Every `press` named the fixture's `--window-id`. Each one followed a foreground check that matched the fixture, except the headless Escape (see Fixture above). | — |

Two notes on row 4, for `s5-overlay-esc` (DM-1042/1043). First, every key the fixture received, injected by either
backend, has `isTrusted: true`, so an app cannot tell an injected key from a physical one. The kill switch has to read
the `LLKHF_INJECTED` flag in a low-level keyboard hook. OMP documents that its own physical-Esc stop ignores
"synthetic Escape chords", and `computer.capabilities()` reports `globalEscape: true` on this host. Second, the
**physical** ESC press is the person's step at the S5 checkpoint; it was not attempted here and stays **UNPROVEN** in
this report.

In run A the fixture also logged one `keydown` with `key: "Unidentified"` right after "hello" and before Escape, in both
runs. It looks like an artifact of OMP's takeover typing. Its cause is **UNPROVEN**; it changed no text.

## A. OMP built-in computer use: GO

### Per-session launch toggle (exact)

Add this to the per-chat overlay DM already writes (`writeOmpFiles` in `src/main/terminals/ompSession.ts`, passed as
`--config <userData>/agents/omp/<chatId>/config.yml` by `ompArgs` in `src/main/agentChat/agentChatLaunch.ts`):

```yaml
computer:
  enabled: true
  display: all
```

`computer.enabled` is the switch. `display: all` makes the desktop target a composite of every monitor; the default,
`active`, captures only the monitor under the focused window. The probe used exactly the GUI-chat argv shape, with a
temporary overlay and session folder under a unique `%TEMP%\dm1041-omp-*` root that was deleted afterwards:

```text
omp --mode rpc-ui --cwd <probe-root> --append-system-prompt <probe-root>\instructions.md
    --config <probe-root>\config.yml --session-dir <probe-root>\sessions --max-time 12m --max-cost 4
```

The only difference from DM's argv is the `-e <extension>` pair, which the probe left out. Other ways to turn it on,
checked against omp 18.20.2's own docs (`omp://computer-use.md`, `omp://settings.md`): `/computer on|off` toggles the
current session without writing config. Interactive and RPC hosts also watch settings files and pick up changes for
later `eval` calls. There is no CLI flag or environment variable for it. `omp config set computer.enabled` writes the
global config, which would turn it on for the Magos and every worker, so the probe never used it.

No approval was needed. On this host the default approval mode (`yolo`) let every `computer` helper run: the only
`extension_ui_request` frames were three `setWidget` presentation updates, and the harness answered no dialog.
`computer.control.acquire` (held foreground control) was not exercised. It needs
`tools.approval: { computer.control: allow }` (a literal key) to be granted without a person. Whether total control
needs it is **UNPROVEN**: every action here went through per-call takeover without it.

### RPC signature that marks control active

Computer use has **no tool of its own** on the RPC stream. Every action is an `eval` call: `toolName: "eval"` was the
only tool name in every `tool_execution_*` frame and tool-call delta of both runs, and the `computer.*` calls appear
only inside `args.code` and the result text.
So "control active" has to come from the session's configuration, read back over RPC. Two frames distinguish it, and
both were checked against a negative control (`omp-computer-off.mjs`, no model call, no desktop access):

| Frame | `computer.enabled: true` | Overlay without it |
| --- | --- | --- |
| `prompt` `/computer status` → `command_output.text` (then `response` with `data.agentInvoked: false`) | `Computer use: enabled · prelude: active · configured: display=all, …` | `Computer use: disabled · prelude: inactive · configured: display=active, …` |
| `get_state` → `data.systemPrompt` contains ``The `computer` eval prelude is enabled.`` | `true` | `false` |

Recommended definition, matching the fail-safe the ticket sets out: **control is active from the moment DM launches
a chat with `computer.enabled: true` in its overlay until that process exits.** DM confirms it once after `ready`
with `/computer status`, expecting a `command_output` that starts `Computer use: enabled`, and re-checks whenever it
toggles the setting. Per-action evidence comes after the fact: an `eval` `tool_execution_start` whose `args.code`
uses `computer.`, and result lines such as `click ran in takeover because window … drops background mouse_click
events …`. Those mark input that took the foreground.

### What the transcript shows

Committed: `docs/reports/desktop-control-backend/omp-computer-use.rpc.redacted.jsonl` (run a2: 410 stdout frames plus
the harness's 7 stdin commands as `dir: "in"` lines, redacted). Stdout frame counts: `ready` 1, `response` 7,
`available_commands_update` 1, `command_output` 1, `extension_ui_request` 3 (`setWidget`), `advisor_cost_changed` 1,
`agent_start` 1, `turn_start`/`turn_end` 2, `message_start`/`message_end` 4, `message_update` (deltas) 368,
`tool_execution_start` 1, `tool_execution_update` 10, `tool_execution_end` 1, `agent_end` 1, `prompt_result` 1
(`status: completed`, `sessionSettled: true`), `session_settled` 1. The fixed prompt
is `PROMPT` in `scripts/spike/desktop/omp-computer-probe.mjs`. The agent's single `eval` cell and its output are in
`omp-computer-probe.json` under `summary.calls`. The eval result included these lines from OMP:

```text
type ran in takeover because this element of window 865469826 is drawn without a control window of its own, so background keys cannot address it, and focusing it would bring the window to the front; the input was delivered, and focus was not confirmed afterwards
click ran in takeover because window 865469826 (Chrome_WidgetWin_1) drops background mouse_click events: Chromium requires input originating from the system input queue; the input was delivered, and focus was not confirmed afterwards
press ran in takeover because window 865469826 (Chrome_WidgetWin_1) drops background keystroke events: Chromium requires input originating from the system input queue; the input was delivered, and focus was not confirmed afterwards
PROBE_RESULT {"stepMs":{"s1":42,"s2":202,"s3":9,"s4":110,"s5":91,"s6":156,"s7":219,"s8":52},"nodeCount":23,"buttonFound":true,"inputFound":true,"clickPoint":{"x":154,"y":192,"inside":true,…},"windowBounds":{"x":869,"y":509,"width":824,"height":503},"screenshotSize":{"width":815,"height":503}}
```

`computer.capabilities()` on this host: `backend: win32`, `capture`, `input`, `ax`, `backgroundWindowInput`,
`takeover`, `applications`, `menus`, `heldInput`, `globalEscape` all `true`; `spaces: false`; capture, input and AX
permission `granted`; `screenLocked: false`, `displayAsleep: false`.

### Limits

- Electron/Chromium windows drop background input, so on this host every click, typed character and key into the
  fixture took the foreground for that call. This is takeover, not invisible background control. AX `press()` worked
  in the background.
- Screenshots sent to a Claude model are capped at 1280×896 (`computer.maxWidth`/`maxHeight` notwithstanding), so a
  2560×1600 desktop reaches the model at half resolution. Use `win.zoom(...)` for detail.
- OMP writes every computer screenshot to `%TEMP%\omp-computer-*.png` and leaves it there. The desktop ones show the
  person's windows. The build sprint should clean these up or point the files somewhere DM owns
  ([INFERENCE] `browser.screenshotDir` has no `computer` counterpart in `omp config list`).
- One `eval` worker accepts one run at a time, and native input takes an OS-wide input lock (`InputBusy` after 5 s),
  so two chats with computer use contend for the desktop.

## B. vercel-labs agent-desktop v1.3.1: NO-GO as primary backend

### Download and verification (before anything ran)

| Item | Value |
| --- | --- |
| Release | `v1.3.1`, published 2026-11-13T21:02:21Z, https://github.com/vercel-labs/agent-desktop/releases/tag/v1.3.1 |
| Windows asset | `agent-desktop-v1.3.1-x86_64-pc-windows-msvc.tar.gz` (1 835 706 bytes) |
| SHA-256 of the download (`sha256sum`) | `6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13` |
| GitHub Releases API `digest` for that asset (`gh api repos/vercel-labs/agent-desktop/releases/tags/v1.3.1`) | `sha256:6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13`: **match** |
| The release's own `checksums.txt` (API digest `sha256:b12987fd…065f58`, matched) | same line `6ee4b1e0…08c13  agent-desktop-v1.3.1-x86_64-pc-windows-msvc.tar.gz`: match |
| Extracted `agent-desktop.exe` | 4 037 120 bytes, SHA-256 `a7ef5e539fb97287a35eb9ed49d3803b4d6bd705bc4106eb28617229f9be679e`, Authenticode `NotSigned` |
| Host policy | Not blocked: Smart App Control is off (above) and the exe ran. `version`, `status`, `permissions` all `ok` (`automation: not_required`). |
| Isolation | Downloaded into a unique `%TEMP%\dm1041-agentdesktop-*` root; `AGENT_DESKTOP_HOME` pointed into the probe's output folder; no `npm -g`, no install scripts; the root was deleted after the probe and `~/.agent-desktop` was never created. |

### Result

Runs b1, b2 and b7–b9 (`agent-desktop-probe.mjs`), plus ad-hoc variant runs b3–b6 with the same fixture. The committed
record is b9's `docs/reports/desktop-control-backend/agent-desktop-probe.json`. Screenshots, list-windows (which found
the fixture by title as `electron.exe`, `accessible: true`) and key presses work. The **UI tree of an Electron
window could not be read**, and its whole contract is "snapshot, then act on a ref": `click`, `type`, `set-value` and
`focus` all need a ref the snapshot never produced. Driving an Electron app therefore drops to headed coordinate input
with targets found some other way, which defeats the point of the tool. DM itself, VS Code and most of what an agent
would drive on this desktop are Chromium-based. The upstream guide (`skills get platform`, "Chromium and Electron
Trees") expects a 10–25 s settle and then a full tree. The probe gave it up to 30 s and a fresh process each time,
with and without `--force-renderer-accessibility`. The in-box UIA read of the same window returned the whole tree in
about 0.1 s, so the fixture is not the cause. Whether agent-desktop reads non-Chromium apps (Win32, WPF, UWP) is
**UNPROVEN**: the ticket's hygiene rules allow only fixture windows, and the Notepad route was skipped (below).

## C. DM-owned UIA helper: not needed

The ticket says to consider C only if A and B both fail, and A is GO. For the record, the in-box route is feasible
without a native toolchain: `uia-tree.ps1` loads `UIAutomationClient` from PowerShell, walks the ControlView of the
fixture window by HWND in about 0.1 s and finds both controls with physical bounds. `screen.ps1` captures the virtual
screen with GDI in 47–77 ms, and `foreground.ps1` reads the foreground window through `Add-Type` C#. Input through
`SendInput` and the ESC hook were not built: **UNPROVEN**, out of scope once A is GO.

## Recommendation

- **Backend:** OMP built-in computer use (A), enabled per chat through the existing `--config` overlay.
- **Launch toggle:** `computer:\n  enabled: true\n  display: all` in that chat's overlay only; never `omp config set`.
- **Control-active signature:** the overlay setting (fail-safe), confirmed after `ready` by `/computer status` →
  `command_output` `Computer use: enabled · prelude: active …`; `get_state.data.systemPrompt` carries
  ``The `computer` eval prelude is enabled.``. Actions are visible only as `eval` calls.
- **Latency:** AX read about 0.1 s, AX press about 0.09 s, typed text about 0.15 s, pixel click about 0.2 s, ESC about
  0.05 s, desktop screenshot 0.13–0.2 s, all in-process. A whole drive from prompt to settled was about 25 s of model
  time.
- **Coverage limits:** Chromium/Electron input needs takeover (it takes the foreground). Model images are capped at
  1280×896. OMP leaves screenshots in `%TEMP%`. The input lock is desktop-wide. Physical ESC is **UNPROVEN** until the
  S5 checkpoint. Blender is not installed, so its viewport, UI tree and script route were not observed.

## UNPROVEN items

- Physical ESC as an instant kill, with the agent's injected ESC passing through. Injected ESC reached the app (A and
  B) and did not stop OMP; the physical press is the person's step at the S5 checkpoint.
- The cause of the extra `Unidentified` keydown after OMP's takeover typing.
- Whether held foreground control (`computer.control.acquire` with `tools.approval: { computer.control: allow }`) is
  needed or useful for total control.
- agent-desktop on non-Chromium windows (Notepad was not used: on Windows 11 it restores the person's earlier tabs, so
  launching it could put the person's own documents on screen).
- Multi-monitor and mixed-DPI behaviour: the host has one monitor.
- Candidate C's input and ESC-hook paths, which were not built.

## Reproduce

From the repo root, with `node_modules` installed (the scripts use the repo's Electron) and the desktop drawn:

```text
node scripts/spike/desktop/omp-computer-probe.mjs --out <dir>
node scripts/spike/desktop/omp-computer-off.mjs          # negative control
node scripts/spike/desktop/omp-computer-off.mjs --on
node scripts/spike/desktop/agent-desktop-probe.mjs --exe <verified agent-desktop.exe> --out <dir> [--force-a11y]
```

`fixture.mjs` holds the shared fixture launcher, crop, foreground and drawn-desktop helpers, and `omp-transcript.mjs`
the redaction and coordinate checks.

## Attached evidence

| Id | What |
| --- | --- |
| im_01m8hmmbv7zykd5gwhap9kemds (im_A_AFTER) | A: fixture after the OMP-driven session: `clicks=2 text="hello" keys=…,Escape` (desktop capture cropped to the fixture's visible frame) |
| im_01m8hmn8z5v1crhmat94sfytfa (im_B_BEFORE) | B: agent-desktop `screenshot --window-id` of the fixture before any action |
| im_01m8hmp3h1hep3sz4k4y9j4gcq (im_B_AFTER) | B: the same after headed click, typed `hello` and two Escapes: `clicks=1 text="hello" keys=…,Escape,Escape` |
| im_01m8hmq010vrryhvvywpmexq1m (im_B_DESKTOP) | B: agent-desktop `screenshot --screen 0` (whole desktop) cropped to the fixture's visible frame |

The same PNGs are committed beside the JSON records in `docs/reports/desktop-control-backend/`.
