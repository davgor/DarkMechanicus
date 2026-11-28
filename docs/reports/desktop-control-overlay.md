# Desktop-control overlay and physical-ESC kill probe (DM-1042)

Can Dark Mechanicus show a Codex-style "agent in control" border on every screen, and end control instantly on a
**physical** ESC while letting the agent's **injected** ESC through? This report records a bounded, unattended probe
on the person's Windows host. It is evidence for the Sprint 5 design (`docs/design/desktop-control.md`) and the Sprint 6
proposal. It changes no product code: everything lives under `scripts/spike/desktop/`.

**Answer.**

- **Overlay: GO.** One transparent, click-through, non-focusable, topmost Electron window per display stayed above a
  normal, a maximized and a borderless-fullscreen fixture, never took focus, and let a click through to the fixture.
- **Physical-only ESC detection: GO, with the physical press itself UNPROVEN until the S5 checkpoint.** A
  `WH_KEYBOARD_LL` hook run from PowerShell `Add-Type` C# (no native compile) reported every injected Escape as
  `LLKHF_INJECTED`: a `SendInput` Escape from another process and OMP computer use's own `win.press("escape")`. Neither
  fired the kill, and both reached the fixture. The hook survived 10 minutes idle and 2 minutes with the CPU 100 %
  busy without a missed liveness ping. The kill, two fail-closed paths, and the helper's exit with its parent
  were all measured.
- **Kill: overlay gone in about 7 ms, computer-use process tree gone in about 110–135 ms, no injected input after.**

## Time box and host

| Item | Value |
| --- | --- |
| Packet read, worktree and `npm ci` (before the clock) | 2026-11-28T18:08Z |
| Drawn-desktop check (`s4acc-logs/probe2/shot.ps1`: `ok nonblack=1363` of 1363 samples, session 2) | 18:08:37Z, again at 18:19:12Z, 18:29:54Z and 18:41Z |
| Observation clock **start** (after the drawn-desktop check passed) | **2026-11-28T18:08:37Z** |
| Last observation (end of the third hook-endurance run) | 2026-11-28T18:56:39Z |
| Observation clock **end** | **2026-11-28T18:57:00Z**, so **48 min 23 s** of the 90-minute hard limit |
| Clock **reopened** after review (rerun of the helper-killed measurement only) | **2026-11-28T19:05:09Z** to **19:07:47Z** (2 min 38 s; drawn-desktop check `ok nonblack=1363` at 19:07:18Z) |
| Clock reopened again (one `esc-probe --self-test` on the fixed script, 99c830fb) | **2026-11-28T19:10:29Z** (drawn-desktop check `ok nonblack=1363`) to **19:10:35Z** |
| Total observation time | **51 min 07 s** of 90 |
| Host | Windows 11 `10.0.26200`, RDP session 2, one monitor 2560×1600 physical at 150 % (Electron: one display, 1707×1067 DIP, `scaleFactor` 1.5), 16 logical CPUs |
| Electron | 42.11.18 (the repo's `node_modules/electron`) |
| omp | the `%LOCALAPPDATA%\omp\omp.exe` DM-1041 used; `/computer status` → `Computer use: enabled · prelude: active · configured: display=all, maxWidth=3840, maxHeight=2400, backgroundFallback=takeover` |
| `sha256` of `~/.omp/agent/config.yml` before and after every OMP run | `400ac657f93da433140cccc47bdeb3c4e79a39a4394e08069ac2e052d647cc37` (unchanged; the per-run `--config` overlay only) |
| `%TEMP%\omp-computer-*.png` left after the OMP runs | 0: the harness deleted the 2 per run that OMP wrote (`removedOmpScreenshots`) |
| `HKCU\Control Panel\Desktop\LowLevelHooksTimeout` | not set, so the Windows default applies |

Every probe started its own fixture window (the DM-1041 Electron fixture, extended with `--mode`), its own overlay and
its own hook helper in unique `%TEMP%\dm1042-*` roots, and closed them. Every click and untagged key was sent only after
a foreground check returned the fixture's own process. The probes' own tagged keys (liveness pings, self-test Escapes,
the agent stand-in's keys) are swallowed by the hook **while the hook is alive**; once it is gone they reach whatever
window has focus. The hook logs Escape and these tagged keys only, never another key of the person's.

**Host-hygiene deviation (found in review).** Two procedures let the injecting agent stand-in (`inject.ps1 -Loop`,
unassigned VK 0xE8 key-down/up pairs, no character) outlive the hook with no probe fixture in front, so its keys went
to a window that was not a fixture, most likely one of the person's. None of these keys could be observed: the hook
that would have seen them was gone.

- `overlay-probe.mjs` "helper killed" step, in each full run at 18:19Z, 18:29Z, 18:31Z, 18:33Z, 18:36Z and 18:41Z:
  from the helper's death until `taskkill` ended the stand-in (about 80 ms until the parent saw the exit, plus about
  110 ms to end the tree), at one pair per 10 ms, so roughly 20 pairs per run ([INFERENCE] from the timings).
- `esc-probe.mjs --self-test` at 18:15Z, 18:31Z, 18:38Z and 18:43Z: it stopped the hook before ending the stand-in,
  so for up to about 2.5 s (the helper's exit wait plus `taskkill`), at one pair per 50 ms, roughly 50 pairs per run
  ([INFERENCE]). The 18:14Z attempt crashed and the OS ended hook and stand-in together.
- Every hook-helper exit: `Quit()` unhooks before `Environment.Exit`, and the helper's ping thread (one tagged VK
  0xE8 pair per second) could fire in that gap, which lasts milliseconds. A ping sent there would reach the foreground
  window. Not observed and not ruled out ([INFERENCE]); the build helper should stop its ping thread before unhooking.

Fixed in the scripts: every `measureKill` now launches a probe fixture, waits past its re-raises, checks it is in
front at the start and again just before the trigger (and otherwise ends the stand-in before the hook and skips), and
the helper-killed case runs a stand-in that sends no input at all. `esc-probe.mjs` (self-test and the person's run)
uses a stand-in that sends no input, and always ends the tree before the hook.

## Probe 1: the overlay

### Route (exact)

`scripts/spike/desktop/overlay/overlay.electron.cjs`, launched by `overlay/control.mjs` with the repo's Electron and
`ELECTRON_RUN_AS_NODE` (and every other `ELECTRON_*`, `NODE_OPTIONS` and DM session variable) deleted from its
environment. For every `screen.getAllDisplays()` entry it opens one `BrowserWindow` at the display's bounds with
`transparent: true`, `frame: false`, `focusable: false`, `skipTaskbar: true`, `alwaysOnTop: true`, `resizable`/
`movable`/`fullscreenable: false`, `hasShadow: false`, then `setIgnoreMouseEvents(true)`,
`setAlwaysOnTop(true, 'screen-saver')`, `setContentProtection(<on|off>)` and `showInactive()`. The page draws a 4 px
`rgba(255,64,64,0.85)` border and a top-centre note "A Skitarii agent is controlling the desktop — press Esc to stop".
Every 500 ms it re-asserts `setAlwaysOnTop(true, 'screen-saver')` + `moveTop()`, which does not activate it. It rebuilds
its windows on `display-added`, `display-removed` and `display-metrics-changed`. It takes commands as JSON lines over
a loopback TCP socket, because piped stdin lines did not reach this Electron main process in the first attempt. It
removes itself when its parent process ends (250 ms poll, started before anything else), when the command socket
closes, or when no controller connects within 10 s.

On Windows every `alwaysOnTop` level is the same `HWND_TOPMOST` band; z-order inside it is by recency. The fixtures
here are themselves topmost (they must beat the person's always-on-top Dark Mechanicus window, DM-851) and re-raise
0.5, 1.5 and 3 s after showing, so the overlay's 500 ms re-assert is what keeps it on top of them. An ordinary app
window is not topmost and sits under the overlay anyway.

### Result (`overlay-probe.mjs`, record `desktop-control-overlay/overlay-probe.json`)

Final run 2026-11-28T18:41:52Z–18:42:59Z (three earlier runs of the same probe, 18:19Z–18:38Z, gave the same verdicts).

| Fixture state | Fixture window (physical px) | z: overlay / fixture | Foreground before → after the click | Click through the overlay onto "Probe button" | Border points red (GDI) |
| --- | --- | --- | --- | --- | --- |
| Normal (top-centre, touching the top edge) | 711,0 1140×510 | 2 / 3 | fixture → fixture | (875,192) → `clicks=1` | 14/14 |
| Maximized (`win.maximize()`) | −11,−11 2582×1550 | 2 / 3 | fixture → fixture | (153,182) → `clicks=1` | 14/14 |
| Borderless fullscreen (`win.setFullScreen(true)`) | 0,0 2560×1600 | 2 / 3 | fixture → fixture | (153,147) → `clicks=1` | 14/14 |

- **Z-order (window list, `windows.ps1`, EnumWindows top-down).** In all three modes the overlay window
  (`DM-1042 overlay`, 0,0 2561×1601 physical, `WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE`)
  was at z 2, directly above the fixture at z 3. The only windows above it were two 1×1 `ThumbnailDeviceHelperWnd`
  shell helpers at 0,0 (class and bounds only are recorded, never another window's title).
- **Focus.** The foreground window was the fixture before and after the click in every mode; the overlay reported
  `focusable: false`, `focused: false`.
- **Clicks.** A `SendInput` left click at the fixture's "Probe button" centre, which lies inside the overlay window's
  rectangle, reached the fixture (`clicks=1`) in every mode.
- **Border visible on the display.** GDI `CopyFromScreen` (DM-1041's `screen.ps1`) sampled 14 points on the four edges
  of the display; 14/14 were the overlay's red in every mode. The crops below show the border on the fixture's edges
  and the note at top centre; in the maximized crop the bottom border sits over the taskbar row (the overlay covers the
  display bounds, not the work area).
- **Display changes and DPI.** The host has one monitor and its scaling is the person's setting, so adding or removing
  a display and changing DPI were **not exercised** (UNPROVEN). The rebuild handlers exist; the overlay records each
  display's id and `scaleFactor` and sizes each window from `screen.getAllDisplays()`.

### Content protection

`setContentProtection(true)` set the overlay's display affinity to `0x11` (`WDA_EXCLUDEFROMCAPTURE`); off it is `0x0`.
Border samples (14 points each) on the same screen state, first unprotected, then protected:

| Capture route | Unprotected | Protected |
| --- | --- | --- |
| Electron `desktopCapturer` (screen source, full resolution) | 14/14 red, 844 ms | **0/14**, 780 ms |
| GDI `CopyFromScreen` (`screen.ps1`) | 14/14 red | **0/14** |
| **OMP computer use** `computer.screenshot({ silent: true })`, `display: "all"` (the `s5-backend` route; the file OMP writes, 1280×800) | 14/14 red | **0/14** |

So content protection **keeps the border out of every agent screenshot route tested, including OMP's own**. The OMP
pair was taken 4 s apart in one `eval` cell; the harness switched protection on as soon as the first file appeared
(`omp-esc-probe.json` `protectOnAt`, `protectedWhenTaken`). With protection on, the border's presence is proved by the
window list instead: the overlay window stays listed, visible, topmost, above the fixture, with affinity `0x11`.
Whether the person's RDP client still draws a protected window is **UNPROVEN**: this host is only seen through RDP, the
capture APIs above exclude it, and only the person's eyes can say. `esc-probe.mjs` therefore runs **unprotected**.

Recommendation for the build: turn protection **on**, so the model never sees a red frame over the app it drives, and
prove presence through the window list. Re-check at the first checkpoint that the person sees the protected border.

## Probe 2: physical ESC

### Helper route (exact)

`scripts/spike/desktop/esc-hook.ps1`: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File esc-hook.ps1
-ParentPid <pid>`. `Add-Type` compiles a C# class in-process (no SDK, no native module). It calls
`SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle("user32.dll"), 0)` on its main thread and pumps that thread with
`GetMessage`. The callback reads `KBDLLHOOKSTRUCT`, takes a `QueryPerformanceCounter` stamp (the same clock as Node's
`process.hrtime.bigint()`), queues one JSON line for a writer thread and returns at once, so stdout can never stall the
hook. It reports `injected` (`LLKHF_INJECTED`, 0x10) and `lowerIl` (`LLKHF_LOWER_IL_INJECTED`, 0x02).

Liveness, because Windows removes a low-level hook silently when a callback overruns `LowLevelHooksTimeout`:

- a `WM_TIMER` heartbeat every 250 ms from the hook thread's own message loop (the thread is pumping);
- every 1 s the helper `SendInput`s a key tagged in `dwExtraInfo` (`0x444D << 48 | kind << 32 | helper pid`, VK 0xE8,
  unassigned) that its own hook must see and swallow (the hook is still installed).

The parent (`overlay/control.mjs` `controller`) kills when a heartbeat gap exceeds 1000 ms or a ping gap exceeds
2500 ms, when the helper exits, or when `shouldKill` says so. `shouldKill({ key | vk, injected, down })`
(`escDecision.mjs`) is true only for an Escape key-down with `injected === false`; key-ups, other keys and unknown
provenance never kill. `npx vitest run scripts/spike/desktop/escDecision.test.mjs`: 5 tests passed.

### Latencies

| Measure | Value |
| --- | --- |
| `SendInput` (helper's own ping) → hook callback, 10 min idle (594 pings) | p50 0.13 ms, p99 0.39 ms, max 1.18 ms |
| same, 2 min with the CPU 100 % busy (119 pings) | p50 0.10 ms, p99 0.24 ms, max 31.6 ms |
| `SendInput` Escape from a separate process (`inject.ps1`, includes its own process work) → hook callback | 4.2 ms (overlay probe), 4.1 ms (self-test) |
| hook callback → parent Node process (stdout pipe, the controller's receive time) | 0.36 ms |
| KBDLLHOOKSTRUCT `time` → callback (`GetTickCount`, 15.6 ms resolution) | 0 ms, once 16 ms (one tick) |
| kill start → overlay windows destroyed (overlay's own `closed` stamp) | 6.9 ms (stand-in tree), 7.1 ms (OMP tree) |
| kill start → overlay process exited | 75 ms |
| kill start → `taskkill /T /F` exited (tree ended) | 111 ms (stand-in), 135 ms (OMP) |

The physical-ESC figure `esc-probe.mjs` will print is hook callback → overlay destroyed, which on this evidence is
roughly the pipe hop plus the overlay close, a few ms to about 10 ms. That figure is **UNPROVEN** until the person
presses the key.

### Unattended observations

| Observation | Result |
| --- | --- |
| `SendInput` Escape from another process into the fixture (foreground checked) | hook `injected: true`, `own: false`; **no kill**; fixture keydown `Escape`, `isTrusted: true` |
| **OMP computer use's own Escape** (`win.press("escape")` on the fixture, ran in takeover) | hook `injected: true`, `own: false`, `lowerIl: false`; **no kill**; fixture keydown `Escape`, `isTrusted: true`; OMP's prompt completed normally (`status: completed`) |
| Hook alive 10 min idle (run 3, 18:44:38Z–18:54:38Z) | alive: 2375 heartbeats, largest gap 286 ms; 594/594 pings seen, largest gap 1026 ms; CPU 9 % busy; no kill condition reached |
| Hook alive 2 min with the CPU saturated (64 tight-loop worker threads, 4 per logical CPU, started and terminated by the probe; 18:54:38Z–18:56:38Z) | alive: CPU **100 %** busy; 477 heartbeats, largest gap 310 ms; 119/119 pings seen, largest gap 1047 ms; no kill condition reached. Runs 1 and 2 (one busy thread per CPU, 39 % busy in run 2) also kept every ping. |
| Final injected Escape after the load | seen, `injected: true` |
| Helper killed (`taskkill /F` of the helper) → fail closed. Rerun 19:07:24Z–19:07:35Z (`overlay-probe-hookHelperKilled.json`): probe fixture in front at the start and just before the trigger, stand-in sending **no** input | kill reason `hook-exited`; overlay destroyed 8.1 ms after the parent saw the helper exit (92 ms after `taskkill` of the helper started); tree ended 117 ms after kill start, all 3 pids gone, overlay windows 0; the fixture received no key. Observable: the fail-closed kill and its timing. **Not observable**: injected input after the helper died, because the hook that sees it is the thing killed (the stand-in sends none, so there is nothing to see). The six earlier runs of this step had an injecting stand-in and no fixture in front (deviation above); their "0 agent keys after" was vacuous for the same reason. |
| Heartbeat stopped (helper told `mute`) → fail closed | kill reason `heartbeat-lost` 1099 ms after the last heartbeat (limit 1000 ms, 100 ms watchdog); overlay destroyed 9.1 ms after detection; tree ended 112 ms after; 0 agent keys after |
| Helper and overlay exit with their parent: parent is a Node process that spawned them (as DM's main process would) and is terminated | both gone **5.6 ms** after the parent was terminated (both alive just before). Node puts its children in a kill-on-close job object ([INFERENCE] libuv), so Windows ends them with the parent. |
| … the helper's and overlay's own parent watch alone (spawned by the probe, `-ParentPid`/`--parent` pointing at a separate process that is terminated) | overlay gone **297 ms** after (its 250 ms poll); helper unhooked and printed `exit` with `why: "parent-exited"` **4.6 ms** after, its PowerShell process fully gone 2267 ms after |

### The kill

`interrupt` is not a kill: it does nothing without an active turn and waits 5 s before force-stopping
(`src/main/agentChat/agentChatSessions.ts`). The measured kill, `controller.kill` in `overlay/control.mjs`, does two
things at once: it sends the overlay `close` (every window destroyed, then the process exits) and starts
`taskkill /PID <root> /T /F`, exactly as `src/main/processTree.ts` does. It then keeps the hook listening for 1 s.

- **Stand-in tree** (node → powershell `inject.ps1 -Loop`, a tagged key every 10 ms): 6.9 ms to overlay destroyed,
  111 ms to the tree ended; all 3 pids gone; 6 tagged keys arrived between kill start and tree end (the injector kept
  running until taskkill reached it); **0 arrived after the tree ended** in the 1 s watch.
- **OMP's own tree** (the live `omp --mode rpc-ui` session with computer use on, right after it pressed Escape):
  7.1 ms to overlay destroyed, 135 ms to the tree ended, `omp` pid gone; no injected Escape after.

Stated bound from this evidence: **overlay removed within 10 ms and the computer-use tree ended within 150 ms of the
kill decision; no injected input after the tree has ended.** Up to about 10 tagged keys from a stand-in that injects
every 10 ms still landed inside that 110–135 ms window, because `taskkill` is a process start. The build sprint can
narrow it: OMP's own stop (below) halts takeover input at the same physical Escape, and DM can also
`TerminateProcess` the known OMP root at once, after collecting its descendants for the tree kill.

### OMP's physical-Esc stop and the DM kill

DM-1041's backend reports `globalEscape: true`. OMP's own documentation (`omp://computer-use.md`, "Physical `Esc`
pressed anywhere stops takeover input …") says that stop covers takeover input, held control and desktop-level input;
that "the stop never swallows the key"; and that "synthetic Escape chords do not trigger it". It fails the running
`computer` call and refuses later ones until the person's next message; it does not end the process or the overlay.
How the two interact:

- Injected Escape (the agent's own): neither fires. Observed here: OMP's `win.press("escape")` reached the fixture,
  the DM hook flagged it injected and did not kill, and OMP's session completed.
- Physical Escape: both should fire. OMP stops its in-flight takeover input; DM's hook sees the same key, because OMP
  never swallows it, and kills the tree and the overlay. The two are independent, so neither depends on the other
  being installed first. **UNPROVEN** until the person's press; the checkpoint runs DM's hook without OMP.

## Checkpoint procedure for the person (S5)

Agent pre-check, recorded before the checkpoint, in the acceptance worktree at the merged S5 commit (node_modules
matching the lockfile):

```text
cd C:\Users\davgo\dmwork\s5-accept
node scripts/spike/desktop/esc-probe.mjs --self-test
```

It must print `SELF-TEST PASS` and exit 0. On this branch, on the fixed script (commit 99c830fb, stand-in sending no
input), it did at 2026-11-28T19:10:34Z (see `desktop-control-overlay/esc-probe-self-test.txt`: overlay shown on 1
display, two injected Escapes seen as injected, no kill, `electronRunAsNodeInParent: true`,
`electronRunAsNodeStripped: true`, exit code 0). The earlier passing runs (18:15Z–18:43Z) used the injecting stand-in
described under the host-hygiene deviation.

The person's one step, on the Windows host with the desktop in view:

```text
cd C:\Users\davgo\dmwork\s5-accept
node scripts/spike/desktop/esc-probe.mjs
```

1. A light red border with the note "A Skitarii agent is controlling the desktop — press Esc to stop" appears around
   every display. Press **Esc** on the physical keyboard. Expected: the border disappears at once and the terminal
   prints `PHYSICAL ESC → kill in <ms>` and one JSON line (`reason: "physical-esc"`, `taskkillExit: 0`, the stand-in
   tree ended); exit code 0. The stand-in sends no input, so nothing is typed into the person's windows.

If no Escape arrives within 5 minutes the script removes the border, prints `No Escape within 5 minutes`, and exits 2.
Any other ending (`KILL (hook-exited)`, `KILL (heartbeat-lost)`, `KILL (ping-lost)`) means the fail-closed path fired
instead and the physical press is not proven. It may be run from a DM terminal: it deletes `ELECTRON_RUN_AS_NODE` before
starting Electron. Escape from a remote-desktop client arrives as a physical key in the session ([INFERENCE]: RDP input
is not `SendInput`), which is the press that counts on this host.

## UNPROVEN limits (for the design)

- **The physical Escape itself**, its callback-to-overlay time, and the OMP and DM stops firing together: the person's
  step at the S5 checkpoint.
- **Exclusive-fullscreen apps** (as opposed to borderless) may take the display and hide the overlay. Not testable
  without such an app; none was launched.
- **Elevated windows** (for example Task Manager): a medium-integrity hook does not see keys while an elevated window
  has focus (UIPI), so a physical Escape there may not kill, and the helper's own liveness ping may be blocked too and
  read as a lost hook, a fail-closed kill. Testing needs a UAC prompt, so an agent cannot do it unattended.
- **The secure desktop** (UAC prompt, Ctrl+Alt+Del, lock screen): no medium-integrity overlay or hook runs there.
- **Multiple displays, display add/remove and DPI changes**: one monitor; the rebuild path is untested.
- **Whether the person sees a content-protected overlay through RDP.**
- **Exactly why piped stdin did not reach the Electron main process** (the overlay uses a loopback socket instead).

## Reproduce

From the repo root with `node_modules` installed and the desktop drawn:

```text
node scripts/spike/desktop/esc-probe.mjs --self-test          # agent pre-check, exit 0
node scripts/spike/desktop/esc-probe.mjs                      # the person's physical-ESC check
node scripts/spike/desktop/overlay-probe.mjs --out <dir>      # overlay over fixtures, content protection, kill paths
node scripts/spike/desktop/overlay-probe.mjs --out <dir> --only hookHelperKilled   # one kill measurement only
node scripts/spike/desktop/omp-esc-probe.mjs --out <dir>      # OMP computer use's Escape and the OMP tree kill
node scripts/spike/desktop/hook-endurance.mjs --out <file>    # 10 min idle + 2 min CPU load
npx vitest run scripts/spike/desktop/escDecision.test.mjs
```

## Evidence

Committed under `docs/reports/desktop-control-overlay/`: `overlay-probe.json` (18:41Z full run; its
`kills.hookHelperKilled` entry is the flawed procedure, superseded by `overlay-probe-hookHelperKilled.json`, the
19:07Z rerun), `omp-esc-probe.json`,
`omp-esc.rpc.redacted.jsonl` (redacted with DM-1041's `omp-transcript.mjs`; no image payload, no user name),
`hook-endurance.json` (run 3, the saturating load), `hook-endurance-run1.json` and `hook-endurance-run2.json` (two
earlier 12-minute runs with one busy thread per CPU; run 2 measured only 39.1 % CPU busy during that load, run 1 used
the same generator and recorded no CPU figure; both kept every ping and heartbeat),
`esc-probe-self-test.txt`, and the crops below. Every PNG is cropped to a fixture window or to the full display while
a fullscreen fixture covered all of it; whole-desktop captures were deleted as soon as they were sampled.

| Attachment id | File | What |
| --- | --- | --- |
| im_01m8hqxqc3x1qkjhvj0mmyj29v | `overlay-over-top.png` | Normal fixture at top centre: border on its top edge and the note over its title bar (GDI capture cropped to the fixture's visible frame; taken before the click) |
| im_01m8hqxqdhegkcdq50gpfz2qqy | `overlay-over-maximized.png` | Maximized fixture: border on all four edges and the note (cropped to the fixture's visible frame) |
| im_01m8hqxqe3cn3mafd356gx39pw | `overlay-over-fullscreen.png` | Borderless-fullscreen fixture: border on all four edges and the note (the whole display, which the fixture covered) |
| im_01m8hqxqfhwkydphsfrnx2ryw6 | `desktopCapturer-unprotected.png` | `desktopCapturer`, content protection off: the border and note are captured |
| im_01m8hqymhnh196bbjs9c5agbsh | `desktopCapturer-protected.png` | `desktopCapturer`, content protection on: the same screen state with no border or note |
| im_01m8hqxqgma4sp2189hg1wcgn2 | `gdi-unprotected.png` | GDI `CopyFromScreen`, content protection off: border captured |
| im_01m8hqymg8fn46z84k4k5fj0xg | `gdi-protected.png` | GDI `CopyFromScreen`, content protection on: border excluded |
