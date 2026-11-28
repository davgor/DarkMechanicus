# Desktop control: design (DM-1043)

This is how a Skitarii GUI chat gets Codex-level total control of the whole Windows desktop, how the person sees that
control and ends it, and how the build sprint proves it without a person. It is drawn only from the two Sprint 5 probe
reports and the code at `sprint/agent-gui-s5` `df11d4fb`. The build tickets are in
[`docs/reports/desktop-control-s6-proposal.md`](../reports/desktop-control-s6-proposal.md).

**Citation keys.** Factual claims carry a citation:

- **B:n** is line n of [`docs/reports/desktop-control-backend.md`](../reports/desktop-control-backend.md) (DM-1041).
- **O:n** is line n of [`docs/reports/desktop-control-overlay.md`](../reports/desktop-control-overlay.md) (DM-1042).
- `path:n` is a line in the repository at `df11d4fb`.

A claim with no evidence is marked **UNPROVEN**, and the proposal names the build-sprint test that proves or retires it.
**[INFERENCE]** marks a conclusion drawn from evidence rather than observed.

## 1. The person's decisions (fixed)

These are inputs, not choices this design makes. They come from the epic intent §13 and the person's decisions of
2026-11-26 and 2026-11-27.

| Decision | Where this design keeps it |
| --- | --- |
| Codex-level computer use for **Skitarii (OMP) GUI chats only** | §3 eligibility: OMP GUI chats only. Claude, Codex and terminal-surface chats get no toggle, and main refuses them. |
| **Total, unrestricted, whole-desktop control**: screenshots, mouse, keyboard, UI tree, any app | §2: OMP computer use with `display: all`. DM adds no allowlist, no per-action approval and no action broker (§3.2). |
| **No Windows Hello**, no per-action approval | §3.1: one native confirmation at enable, then nothing per action. |
| **Off by default, turned on per chat** | §3.1, §3.4: off on every launch, and never persisted across restarts. |
| While active, a **light red border with the note "A Skitarii agent is controlling the desktop"** on every screen | §5.1 overlay. |
| A **physical ESC kills control instantly**; the agent's own injected ESC reaches the app | §6 hook and kill. |
| The **Magos arbiter never decides desktop prompts** | §5.5 `never_arbitrate` predicate. |
| **DM's own human-only controls are locked while control is active** (2026-11-27) | §5.6 lock, enforced in main. |

The overlay is a visibility aid, not containment, and total control means the agent can damage the machine. The person
accepted both (§10).

## 2. Backend: OMP built-in computer use

**Chosen: OMP's built-in computer use** (candidate A, omp 18.20.2), enabled for one chat through the `--config`
overlay DM already writes for that chat (B:8-11, B:220-221).

What the probe showed:

- **It drives the desktop from a GUI-chat argv.** The probe used the GUI-chat argv shape, `omp --mode rpc-ui … --config
  <overlay> --session-dir …`, without the `-e` pair (B:107-114). From that it took a whole-desktop screenshot in
  129–202 ms, read the UI tree (23 nodes, ~0.1 s), pressed a button by its accessibility element (85–91 ms), typed
  text (144–156 ms), clicked by pixel (208–219 ms) and pressed Escape (50–52 ms). The fixture read back
  `clicks=2 text="hello"` (B:73-76, B:225-227).
- **Chromium/Electron input takes the foreground.** These windows drop background input, so input to them ran in
  takeover. OMP said so in its result text (B:157-160, B:170-172).
- **No approval prompt was needed** under the host's default approval mode (B:120-121).
- **No model spend was needed for the signature.** `omp-computer-off.mjs` confirms the control-active signature with
  no model call and no desktop access (B:132-137).

**Rejected:**

- **vercel-labs agent-desktop v1.3.1: NO-GO.** Its UI-tree `snapshot` of an Electron window never completed, at any
  timeout up to 30 s, even with `--force-renderer-accessibility` (B:75, B:200-206). Every `click`/`type` needs a ref
  from that snapshot, so driving Chromium apps fell back to headed coordinate input (B:74, B:201-203). DM, VS Code and
  most of what an agent would drive here are Chromium-based (B:204). Whether it reads Win32/WPF/UWP is **UNPROVEN**
  (B:207-208); with A at GO, that question does not need answering.
- **A DM-owned UIA helper (candidate C): not built.** It was not needed. The in-box UIA read is feasible (~0.1 s)
  (B:212-216), but its `SendInput` input and ESC paths are **UNPROVEN** (B:216, B:242), and building them would
  duplicate what A already does.

**Limits carried into the build:**

- Model images are capped at 1280×896 (B:173-174).
- OMP leaves every computer screenshot in `%TEMP%\omp-computer-*.png` (B:175-177); §5.7 deals with this.
- The OS-wide input lock (`InputBusy` after 5 s) means two computer-use chats contend for the desktop (B:178-179);
  §4 makes ownership single.
- Multi-monitor and mixed-DPI behaviour is **UNPROVEN**: the host has one monitor (B:241, O:109-111, O:264).
- The cause of one extra `Unidentified` keydown after takeover typing is **UNPROVEN**. It changed no text (B:89-90,
  B:236).

## 3. Wiring: how a chat turns control on

### 3.1 Chosen: a main-owned launch toggle

The chat header gets a **Desktop control** toggle, Off by default, shown only on an OMP GUI chat. Turning it on:

1. The renderer calls one new IPC channel, `agentChat:setDesktopControl {folder, chatId, on}`, on the existing
   `AGENT_CHAT_CHANNELS` map (`src/shared/agents/agentChat.ts:13`). The channel is registered through the sender guard
   (`src/main/ipcGuard.ts:64-75`), like every other channel. The request carries no argv, env, path or config text.
2. Main checks eligibility:
   - an OMP GUI chat on the GUI surface;
   - Windows;
   - no other owner (§4);
   - no lock-refused state (§5.6).

   Main then shows **one native confirmation** (`dialog.showMessageBox`, Cancel by default). This is the same pattern
   as the YOLO and loosen-settings confirmations (`src/main/desktop/bootstrap.ts:233-238`, `:276-290`). There is no
   Windows Hello.
3. Main stops the chat's live process, if one is running, with the force kill of §6.3. It then relaunches the chat on
   its same session through the existing main-owned launch spec:
   - `agentChatLaunch` (`src/main/agentChat/agentChatLaunch.ts:94-111`) builds the argv;
   - `writeOmpFiles` (`src/main/terminals/ompSession.ts:96-106`) writes the per-chat overlay, with these lines added:

   ```yaml
   computer:
     enabled: true
     display: all
   ```

   This is exactly the toggle the probe proved (B:96-105). The overlay lives at
   `<userData>/agents/omp/<chatId>/config.yml` (`src/main/terminals/ompSession.ts:70-76`) and reaches OMP as
   `--config` (`src/main/agentChat/agentChatLaunch.ts:79-81`).
4. After OMP's `ready` frame, main sends `/computer status` and requires a `command_output` that starts
   `Computer use: enabled`. It also requires `get_state.data.systemPrompt` to contain
   ``The `computer` eval prelude is enabled.`` (B:134-141, B:222-224). Until both hold, the chat shows "Starting desktop
   control"; any other answer ends control (§6) with the reason shown. The overlay and the ESC hook (§5.1, §6.1) are up
   **before** the OMP process starts, so no computer-capable process ever runs without them.

Turning it off is the kill (§6.3), never `/computer off`. The chat then restarts lazily on its next message, through
the normal launch with the default overlay (§3.4).

**Per-session only.** DM never runs `omp config set computer.enabled`: that writes the person's global config and would
turn computer use on for the Magos and every worker (B:117-118). Both probes left the global config hash unchanged
(B:21-23, O:35). There is no CLI flag or env variable for it (B:117).

### 3.2 Rejected: a DM broker with `dm desktop_*` commands

The alternative copies S4's browser pattern: grant-gated `dm desktop_screenshot / click / type / press` commands that DM
executes. It is rejected for these reasons:

- **DM does not need to mediate each action.** The person chose no per-action approval, no allowlist and no broker
  (ticket rules; §1). A broker would add exactly the mediation layer they ruled out.
- **The backend already exists inside OMP.** Computer use runs in OMP's `eval` prelude (B:128-131), with AX trees,
  takeover input, display composites and its own physical-Esc stop (B:164-166, O:208-211). A broker would rebuild all
  of this in DM: candidate C, whose input and ESC paths are **UNPROVEN** (B:216).
- **Observing RPC frames is enough.** DM needs to know that control is active and what the agent did. The active
  signal is the overlay setting, confirmed by `/computer status` and `get_state` (B:139-144). Per-action evidence is
  the `eval` `tool_execution_*` frames whose `args.code` uses `computer.`, plus OMP's takeover result lines (B:142-144).
  The GUI already translates both into tool cards.

**Cost of the choice:** DM cannot veto an individual action. That is the person's requirement, not a gap.

### 3.3 Eligibility

| Chat | Toggle | Why |
| --- | --- | --- |
| OMP (Skitarii) GUI chat, any role, folder or project-less, Windows | Shown | Skitarii only (§1). |
| Claude GUI chat, any terminal-surface chat, a Codex chat (S7) | Not shown; main refuses with `unsupported_agent` | Skitarii only. Terminal launches (`src/main/terminals/terminalSessions.ts:608`) never get the computer overlay. |
| The Magos arbiter session | Never | It is tool-less and grant-less by design (epic §11). |
| Non-Windows | Not shown | The hook and overlay evidence is Windows-only (O:32). |

Switching a chat's surface to the terminal is refused while that chat holds control, because the terminal would launch
OMP outside this design. The other terminal↔GUI ownership rules are unchanged (`src/main/agentChat/agentChatWiring.ts:1-11`).

### 3.4 Never resumed with control on

Control lives **only in main's memory** for the life of one OMP process. It is never written to the chat record, the
restart marker or the session folder. This matters for the restart paths:

- Every launch except the one in §3.1 step 3 writes the default overlay. `writeOmpFiles` rewrites `config.yml` at every
  start (`src/main/terminals/ompSession.ts:104`), and the GUI start calls it on each launch
  (`src/main/agentChat/agentChatSessions.ts:812`).
- So the following all come back with computer use **off**:
  - the GUI manager's lazy `--resume` on the next message;
  - the Magos restart resume after an update (`src/main/agentChat/restartResume.ts:1-6`);
  - a model-switch relaunch;
  - revision 21's **Techmarine boot resume** (`s6-repair-resume`: open incidents resume their same session after
    any app restart, epic §16).
- A Techmarine repair chat is an OMP GUI chat. The toggle works on it like any other chat, but a resumed Techmarine
  is a fresh launch and comes back with control off. The person has to enable it again, with the overlay, the hook
  and the confirmation.

Whether a session that ran with `computer.enabled: true` and is resumed with the default overlay reports
`Computer use: disabled` is **UNPROVEN**. The probe never resumed a session; it only showed that `/computer on|off`
toggles the current session without writing config (B:115-116), and DM never sends that command. The build sprint's
live-facts probe proves it with `/computer status` after a resume, and a unit test pins the invariant that only the
desktop-control path passes the computer overlay.

## 4. Ownership: one controlling chat per desktop

Main holds a single `DesktopControl` owner, `{folder, chatId, pid, since}` or none, in a new main module.

- An enable for any other chat is refused (`conflict`: "Desktop control is already on for <chat>; stop it first").
  The refusal happens before the confirmation is shown.
- The owner is cleared only by the kill (§6.3), after the OMP tree has exited.
- Evidence for one owner: OMP's native input takes an OS-wide lock (`InputBusy` after 5 s), and one `eval` worker
  accepts one run at a time (B:178-179). Two controlling chats would fight over the same mouse.
- Scope: one owner per Dark Mechanicus process. A second DM instance with an isolated profile could also enable
  control, which is a residual risk (§10). No probe covered two instances.

## 5. The active signal and its UI

### 5.1 The overlay: border and note on every display (GO)

The route below is exactly as probed (O:69-80, `scripts/spike/desktop/overlay/overlay.electron.cjs:69-75,155,158`):

- one `BrowserWindow` per `screen.getAllDisplays()` entry, at the display's bounds, with `transparent`, `frame: false`,
  `focusable: false`, `skipTaskbar`, not resizable, movable or fullscreenable, and no shadow;
- then `setIgnoreMouseEvents(true)`, `setAlwaysOnTop(true, 'screen-saver')` and `showInactive()`;
- a 500 ms re-assert of `setAlwaysOnTop(true,'screen-saver')` plus `moveTop()`, which does not activate the window;
- a rebuild on `display-added`, `display-removed` and `display-metrics-changed`.

The page draws a 4 px `rgba(255,64,64,0.85)` border and a top-centre note, "A Skitarii agent is controlling the desktop
— press Esc to stop" (O:74-75).

What the probe showed:

- In all three modes (normal, maximized, borderless fullscreen) the overlay sat at z 2 directly above the fixture.
  Focus never moved, a click went through to the fixture, and 14/14 border samples were red (O:91-108).
- A normal window is not topmost and sits under the overlay anyway (O:82-85).

**In-process, not a helper process.** The spike ran the overlay as a separate Electron process because piped stdin
did not reach its main process (O:77-78, O:266). The product creates the windows in DM's own main process, which needs
no command channel at all:

- a kill closes them with a direct call, and the probe measured overlay-destroyed at 6.9–7.1 ms even across a socket
  (O:165);
- a DM crash takes them down with the process.

The cause of the piped-stdin oddity therefore stays **UNPROVEN** and no longer matters.

`src/main/windows.test.ts:17-23` asserts that only `index.ts` creates a `BrowserWindow`. The overlay ticket changes that
test deliberately: the allowed set becomes `index.ts` and the one overlay module, and the test also pins the overlay
window's options (click-through, non-focusable, `screen-saver`, content protection).

**Content protection on.** With `setContentProtection(true)` (affinity `0x11`, `WDA_EXCLUDEFROMCAPTURE`), the border
was absent from `desktopCapturer`, GDI and OMP's own `computer.screenshot`, 0/14 each, against 14/14 unprotected
(O:113-124). So the model never sees a red frame over the app it drives. Presence is then proven by the window list:
the overlay window stays listed, visible, topmost and above the fixture, with affinity `0x11` (O:126-127). Whether the
person sees a protected overlay through their RDP client is **UNPROVEN** (O:128-129, O:265). The build sprint's single
physical step (§9) runs on the product's protected overlay, so the person's own eyes settle it in the same step: the
border appears, they press ESC, and it disappears.

**Coverage limits** (O:258-264): an exclusive-fullscreen app may take the display and hide the overlay, and the secure
desktop shows no overlay. §7 says what the person should expect.

### 5.2 Header badge and Stop

The chat header is `ChatHeader` (`src/renderer/src/agentChat/AgentChat.tsx:217-237`).

- **While control is active:** the header shows a light red **Desktop control** badge (`role="status"`, text "Desktop
  control on") and a **Stop desktop control** button.
- **When it is off:** the toggle reads "Desktop control: Off".

Both reflect a main-pushed `desktopControl` state (`{owner, phase: 'starting'|'active'|'ending', reason?}`) on the
existing chat event push. The renderer never decides the state.

### 5.3 Lock on the agent tree row

The controlling chat's root row in the right-rail tree (`src/renderer/src/agentTree/AgentTree.tsx:190`, `TreeRow`) shows
a lock glyph with the accessible name "Desktop control on". Every other row is unchanged.

### 5.4 Needs-you and notification policy

- **Turning control on or off** is the person's own act at the desktop, so it raises no OS notification.
- **A fail-closed or external end** raises an OS notification and a needs-you item on the chat: "Desktop control ended:
  <reason>". This covers hook-helper death, lost heartbeat or ping, crash recovery, an OMP exit, and
  `/computer status` not confirming. It uses a new `desktop_control` kind in `NOTIFICATION_EVENTS`
  (`src/shared/desktop/notificationSettings.ts:10`), on by default and governed by the existing focus rules.
- **Prompts from the controlling chat** stay ordinary `approval_needed` and question attention. They are never sent to
  the arbiter (§5.5).

### 5.5 The Magos arbiter never decides desktop prompts

The rule module already has the seam:

- `registerNeverArbitrate` adds a predicate (`src/main/magos/arbitrationRules.ts:95-101`);
- `registeredExclusion` runs every registered predicate after the built-in rules, and a predicate that throws excludes
  (`:150-159`);
- predicates receive `ArbitrationInput`, which carries the whole `chat` and the `prompt` (`:25-41`);
- the browser approval predicate is registered the same way in `wireAgentChats`
  (`src/main/agentChat/agentChatWiring.ts:128-137`, unregistered at `:171`).

**Design:** the wiring registers `desktopControlPrompt` beside `browserToolApproval`. It returns true for:

1. **any prompt of the controlling chat**: `input.chat.id` and `input.chat.folder` match the `DesktopControl` owner,
   including prompts of its subagent threads;
2. **any prompt whose content is about computer use**, which is checked from `input.prompt`:
   - `prompt.tool.name === 'eval'` with `tool.input.code` matching `\bcomputer\s*\.`;
   - a tool name starting `computer`;
   - or `prompt.title`/`prompt.detail` naming `computer.control`.

   This is the shape B:128-131 and B:122-123 describe.

A false positive only sends a prompt to the person, the same trade-off as the browser predicate
(`src/main/agentChat/agentChatWiring.ts:122-127`).

The predicate is defence in depth today. OMP prompts already stop at `unsupported_kind`
(`src/main/magos/arbitrationRules.ts:46-50,132`), and only a run's Magos chat is arbitrated at all (`:130`). The
predicate keeps the rule true if OMP ever becomes arbitrable, and if a Claude-kind Magos ever relays a computer prompt.
Its tests drive it with `agentKind: 'claude'` so that the predicate, and not an earlier rule, is what excludes.

### 5.6 DM's human-only controls are locked while control is active

While any chat holds desktop control, the controls that make the person's decisions are disabled and inert in the DM
window, and their native confirmations refuse. The person ends control first, with physical ESC or Stop.

This protects DM's own approval boundary against an agent that can click anything. It is **not** a consent verifier,
allowlist or approval broker for the agent's own desktop actions, which stay unrestricted.

**Enforcement is in main.** One check, `desktopControl.locked()`, is applied at three choke points. The renderer only
mirrors it.

1. **IPC sender guard.** `guardIpc` (`src/main/ipcGuard.ts:64-75`) is the one wrapper every handler is registered
   through ("nothing else in the main process touches `ipcMain`", `:60-63`). It gains a `locked(channel, args)` option.
   A locked call returns `{ ok: false, error: { code: 'desktop_control_active' } }`, a new `DOMAIN_ERROR_CODES` entry
   (`src/shared/domain/errors.ts:5`), and the handler never runs.
2. **Human-only desktop commands.** `dm:command` (`src/main/desktop/ipc.ts:18-20`) reaches `runCommand`
   (`src/main/desktop/handlers.ts:150-163`). There, after `assertDesktopCommand`, a command is refused when its
   capability, `COMMAND_CAPABILITIES[name]` (`src/core/commands/capabilities.ts:25`), is in `HUMAN_ONLY_CAPABILITIES`
   (`src/core/authz.ts:95`). This rule covers every human-only command by construction, including any added later.
3. **Native confirmations.** Each main-side confirmation that approves or loosens returns "not confirmed" while
   control is active, without showing the dialog:
   - `confirmInstall` (`src/main/desktop/bootstrap.ts:226-231`);
   - `confirmYolo` (`:233-238`);
   - `confirmCustomAgent` (`:268-273`);
   - `confirmNotificationSettings` (`:276-290`);
   - the desktop-control enable confirmation itself (§3.1).

Every locked control, by component and handler:

| Control (component) | Channel → main handler | Lock rule |
| --- | --- | --- |
| Checkpoint **Approve** (`CheckpointScreen.tsx:403-416` `GateActions`; `workspaceActions.ts:354-368`) | `dm:command` `approveAndAdvance` / `approveCheckpoint` → `runCommand` | `checkpoint.approve` is human-only (`capabilities.ts:154-157`) |
| Checkpoint **redraft approval** (`EpicWorkspace.tsx:136`, `workspaceActions.ts:333-349`) | `dm:command` `approveWithRedraft` | `checkpoint.approve` |
| Checkpoint delivery **waiver** (`workspaceActions.ts:385-390`) | `dm:command` `waiveDelivery` | `checkpoint.approve` (`capabilities.ts:118`) |
| Checkpoint **kick-back** | No separate command exists at `df11d4fb`. The person sends a sprint back by not approving and editing the draft (`CheckpointScreen.tsx:416` `onEditDraft`), and saving a plan is `savePlan` (`plan.save`, not human-only). | Covered by the redraft rows; any future checkpoint kick-back under `checkpoint.approve` is covered by rule 2 automatically |
| **Retry grant** (`CheckpointScreen.tsx:412`; `workspaceActions.ts:374`) | `dm:command` `grantRetry` | `ticket.retry_grant` (`capabilities.ts:159`) |
| Auto-continue authorisation (`workspaceActions.ts:382`) | `dm:command` `authorizeAutoContinue` | `run.authorize_auto` |
| Kanban card **Approve** (`KanbanCardPanel.tsx:246`) | `dm:command` `approveKanbanCard` | `kanban.review` (`capabilities.ts:180`) |
| Learning card **Approve** (`KanbanCardPanel.tsx:250`) | `dm:approveLearningCard` (`learningApprovalIpc.ts:30`) | locked channel (rule 1) |
| Kanban card **Kick back** (`KanbanCardPanel.tsx:304`) | `chats:kickBackKanbanCard` (`src/main/agents/chatIpc.ts:19`) | locked channel (rule 1) |
| Kanban card **Delete** (`DeleteCardControl.tsx:39`) | `dm:command` `deleteKanbanCard` | `kanban.delete` (`capabilities.ts:182`) |
| Kanban card **Play** (`StartCardDialog.tsx:40`) | `chats:startKanbanCard` (`chatIpc.ts:18`); `dm:command` `playKanbanCard` | locked channel; `kanban.play` |
| Browser site **Allow** (once/always) (`OriginPromptCard.tsx:72`) | `browser:decideOrigin` (`src/main/browser/browserIpc.ts:261`) with `decision` `once`/`always` (`src/shared/browser/browserApi.ts:29-31`) | locked channel when the decision is not `deny`. Deny stays available. |
| Browser on/off when turning it **on** | `browser:setEnabled` (`browserIpc.ts:267`) | locked channel when enabling |
| **Settings that loosen security** (`NotificationSettings.tsx:100`) | `settings:setNotifications` (`src/main/desktop/settingsIpc.ts:34`) → `confirmNotificationSettings` | rule 3: the confirmation refuses, so a loosening change is refused. Tightening still saves. |
| **YOLO** enable (`GrantsCard.tsx:151`) | `dm:yolo` (`src/main/desktop/ipc.ts:56`) → `confirmYolo` | rule 3 |
| Agent download / custom CLI approval | `agents:download`, `agents:addCustom`, `agents:updateCustom` (`ipc.ts:35-37`) → `confirmInstall` / `confirmCustomAgent` | rule 3 |
| Grant issue/revoke, epic/ticket delete, run queue, storage switch, conflict resolution, backup, feedback, cross-repo corrections, learning retire/replace, mail management | `dm:command` with those commands; `corrections:createCrossRepo` (`crossRepoCorrections.ts:519`) | rule 2 (all in `HUMAN_ONLY_CAPABILITIES`, `authz.ts:95-130`); the corrections channel is locked by rule 1 |
| **Desktop-control enable** for another chat | `agentChat:setDesktopControl` | single owner (§4) refuses first; the confirmation also refuses (rule 3) |

**What stays available while locked:**

- the header **Stop desktop control** button, chat Stop, and every kill path (§6);
- reading everything;
- sending messages to chats;
- Deny on a browser origin prompt.

The agent can press Stop too; that only ends its own control.

**Renderer mirror.** Each listed component disables its button when the pushed state says control is active and shows
"Locked while desktop control is on: press Esc or Stop first". This is presentation only: the main-side refusal is
what each test asserts.

**Open question (for the orchestrator):** the person's list does not name the docked approval card's **Allow** on a
chat's own pending tool prompt (`agentChat:answer`, `src/main/agentChat/agentChatIpc.ts:244`). An agent with control
could click Allow on another chat's prompt. The recommendation is to lock Allow answers on `agentChat:answer` while
control is active and keep Deny and question answers available. The proposal carries it as an explicitly marked
optional criterion, so the person can decide it at the checkpoint.

**Residual, stated plainly:** the lock covers the DM window only. An agent with total control can type into any
terminal on the desktop. Human-only capabilities are never granted to agents (`src/core/authz.ts:94-95`,
`src/core/services/grants.ts:11-12`), so an agent's own grant cannot approve anything. Any shell the person left open
with their own credentials is outside this lock (§10).

### 5.7 Screenshots in the chat

The agent's desktop screenshots should render inline through S3's chat-image path (`src/main/agentChat/toolResultImages.ts`,
`src/main/agentChat/chatImages.ts`). The probe found a gap:

- **The images are not on the stream.** The rpc stream carried no image payload: tool-result images reached the model
  but were not echoed on stdout (B:56). So the translator receives nothing to lift, and inline rendering from the
  stream is **UNPROVEN** (at best).
- **The PNGs are left on disk.** OMP writes each computer screenshot to `%TEMP%\omp-computer-*.png` and leaves it
  there, and the files show the person's desktop (B:50-53, B:175-177).

**Design:**

1. The controlling launch sets `TEMP` and `TMP` in that OMP process's env to a DM-owned per-chat folder,
   `<userData>/agents/omp/<chatId>/computer`. Main builds this env (`environmentFor`,
   `src/main/agentChat/agentChatLaunch.ts:41-50`); the renderer never supplies it.
2. Main watches that folder for `omp-computer-*.png`. Each new file is stored through the chat image store's
   `putToolImage` (`src/main/agentChat/chatImages.ts:98`), which runs the S3 intake (`inspectToolImageBytes`,
   `src/core/attachments/intake.ts:198`), as a tool image of the running `eval` item. It then shows inline like any
   agent image result and can become ticket evidence.
3. Main deletes the folder when control ends. This also closes the `%TEMP%` leak.

That OMP honours `TEMP`/`TMP` for these files is **UNPROVEN** ([INFERENCE]: Node's `os.tmpdir()` reads `TEMP` on
Windows; B:177 notes there is no `browser.screenshotDir` counterpart). The live-facts probe proves it first. If it is
false, the fallback is to collect `%TEMP%\omp-computer-*.png` files whose creation time falls inside the owner's
session and move them into the chat folder. Single ownership (§4) keeps the attribution unambiguous.

**Privacy:** a desktop screenshot is the person's own screen, shown only in their own chat on their own machine. It
never goes into an evidence attachment unless the person attaches it (S3 rules).

## 6. Kill paths and their bounds

### 6.1 The physical-ESC hook (GO, physical press UNPROVEN)

**Helper.** A `WH_KEYBOARD_LL` hook in a PowerShell `Add-Type` C# helper, with no native compile (O:136-143):

- It reports `LLKHF_INJECTED` (0x10) and `LLKHF_LOWER_IL_INJECTED` (0x02) for each key (O:143).
- It logs only Escape and its own tagged keys, never another key of the person's (O:42-43).
- The product bundles its source the way the GUI job supervisor is bundled: fixed source, never loaded from cwd
  (`src/main/agentChat/windowsAgentJob.ts:3-4`).

**Decision.** Kill on an Escape key-down with `injected === false`. Key-ups, other keys and unknown provenance never
kill (O:152-154; `scripts/spike/desktop/escDecision.mjs:18-21`, 5 tests passing).

**Injected ESC passes through (proven):**

- a `SendInput` Escape from another process and OMP's own `win.press("escape")` were both flagged injected, neither
  killed, and both reached the fixture with `isTrusted: true`. OMP's prompt completed (O:177-178, B:76);
- an app cannot tell the two apart (`isTrusted` is true for both), which is why the hook flag is the only signal
  (B:82-85).

**Physical ESC (UNPROVEN until the press):**

- RDP-client keys arrive as physical in the session ([INFERENCE], O:250-252).
- OMP's own physical-Esc stop also fires on a physical Escape and halts takeover input. It never swallows the key, so
  DM's hook still sees it (O:206-218). The two are independent.

**Liveness, because Windows silently removes a slow low-level hook:**

- a `WM_TIMER` heartbeat every 250 ms;
- a tagged ping key every 1 s that the hook must see and swallow (O:145-149).

The parent kills when a heartbeat gap exceeds 1000 ms or a ping gap exceeds 2500 ms
(O:151; `scripts/spike/desktop/overlay/control.mjs:26-27,197-198`).

**Endurance:** 10 min idle and 2 min at 100 % CPU passed with no missed ping, max ping latency 31.6 ms (O:160-161,
O:179-180).

**Ping gap at exit (fix carried into the build).** The helper's `Quit()` unhooks before `Environment.Exit`
(`scripts/spike/desktop/esc-hook.ps1:129-132`), and the ping thread (`:120`) could send one tagged key in that gap,
which would reach the foreground window (O:56-58, [INFERENCE]). The product helper stops its ping thread, then unhooks,
then exits. Its test asserts the order.

### 6.2 Bounds

All figures are from the Windows host. "Kill start" is main's kill decision.

| Path | Trigger reaches main | Overlay removed | Control off (computer-capable tree ended) | Evidence |
| --- | --- | --- | --- | --- |
| **Physical ESC** | hook callback → parent 0.36 ms | ≤ 10 ms (6.9–7.1 ms measured) | ≤ 150 ms (111 ms stand-in, 135 ms OMP tree) | O:163-167, O:194-201; the press itself **UNPROVEN** (O:169-171) |
| **Header Stop** | IPC hop (not measured) | ≤ 10 ms after main receives it | ≤ 150 ms | same kill as ESC; the IPC hop is **UNPROVEN**, measured by the e2e `desktop-stop` step |
| **Chat stop / delete** (`agentChatSessions.ts:1138-1156`) | direct call | ≤ 10 ms | ≤ 150 ms | same kill. The kill runs **before** the normal 5 s bounded shutdown (`:250-256`), never the 5 s-grace `interrupt` (`:1039-1058`) |
| **Folder untrack** (`releaseFolder`, `:1163-1172`, S3's leak fix) | direct call | ≤ 10 ms | ≤ 150 ms | same kill, inside `stopWhere` |
| **Agent removal** (`endAgent`, `:1173-1175`) | direct call | ≤ 10 ms | ≤ 150 ms | same kill |
| **Quit** (`quitDisposal.ts:62`, `dispose` `agentChatSessions.ts:1176-1190`) | `before-quit` | ≤ 10 ms | ≤ 150 ms, inside the 5 s quit bound | same kill, run first in dispose |
| **OMP exits on its own** | process `exit` | ≤ 10 ms | already ended | owner cleared on exit |
| **Hook helper dies** | helper exit seen by parent ~80–92 ms after it is killed | 8.1 ms after the exit is seen | 117 ms after kill start | O:182 (rerun 19:07Z) |
| **Lost heartbeat** | ≤ 1000 ms limit + 100 ms watchdog (1099 ms measured) | 9.1 ms after detection | 112 ms after detection | O:183 |
| **Lost ping** (hook silently removed) | ≤ 2500 ms limit + watchdog | ≤ 10 ms after detection | ≤ 150 ms after detection | O:151; the same kill path. Ping loss itself was not induced in the probe: **UNPROVEN**, and a unit test with an injected clock proves the watchdog |
| **DM main crash** | — | windows die with the process | the helper's parent watch: unhooked 4.6 ms after the parent ended. Node's children ended 5.6 ms after the parent was terminated ([INFERENCE] kill-on-close job). The OMP CLI runs in DM's owned job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`windowsAgentJob.ts:137`, `agentProcess.ts:215-224`) | O:184-185; the chain from DM crash to the OMP tree ending is **UNPROVEN** for the real OMP and is proven by the e2e `desktop-crash` step (`taskkill /F` of DM main; OMP pid, helper and overlay all gone within 1 s) |

**Stated bound (from O:200-201):** the overlay is removed within **10 ms** of the kill decision. The computer-capable
tree has ended within **150 ms** of the kill decision. No injected input arrives after the tree has ended (0 tagged
keys in the 1 s watch, O:196).

Up to about 10 keys from a stand-in that injected every 10 ms still landed inside the 110–135 ms window, because
`taskkill` is a process start (O:201-204). The build narrows that window in two ways:

- OMP's own physical-Esc stop halts takeover input at the same keypress (O:202-203);
- the kill uses the GUI process's force stop (`AgentProcess.stop({ force: true })`, `agentProcess.ts:206-211`), which
  starts the tree kill at once.

**Fail-closed bound:** if the hook is silently removed, control ends within 2.5 s plus 150 ms.

### 6.3 One kill, every path

Every path calls one `endDesktopControl(reason)` in main. Its order is fixed:

1. Close every overlay window synchronously.
2. Start the forced tree kill of the controlling OMP process at the same moment. This is not `interrupt` (O:189-192).
3. Keep the hook listening for 1 s and log any injected key that arrives after the tree ended (O:192); the e2e asserts
   zero.
4. When the process has exited, clear the owner, lift the lock (§5.6), stop the hook helper (ping thread first, §6.1),
   delete the screenshot folder (§5.7), and push the state.

The lock is lifted only after the tree is gone, so the agent cannot race an approval click into the gap. `reason` is
one of `physical-esc`, `stop`, `chat-stop`, `chat-delete`, `untrack`, `agent-removed`, `quit`, `omp-exited`,
`hook-exited`, `heartbeat-lost`, `ping-lost` or `status-unconfirmed`. It shows in the chat status line and, for the
fail-closed ones, in the notification (§5.4).

## 7. Known limits: UIPI, fullscreen and the secure desktop

These limits are from DM-1042 (O:254-266). Where a limit is untested, it says so.

| Situation | What the person should expect | Evidence |
| --- | --- | --- |
| **Elevated window in front** (Task Manager, an admin terminal) | A medium-integrity hook does not see keys while an elevated window has focus (UIPI). A physical Esc there may **not** kill. The helper's own ping may also be blocked, which reads as a lost hook and is a fail-closed kill. Expect control to end within about 2.5 s of an elevated window taking focus, or ESC to do nothing until focus leaves it. | O:260-262: **UNPROVEN**, because testing needs a UAC prompt, which an agent cannot handle unattended. The proposal lists it as a person-observable note, not a gate. |
| **Exclusive-fullscreen app** (some games, some 3D viewports) | The app may take the display and hide the border. The hook and the kill still work ([INFERENCE]: the hook is not a window). | O:258-259: **UNPROVEN**, because no exclusive-fullscreen app was launched. Borderless fullscreen was proven covered (O:95). |
| **Secure desktop** (UAC prompt, Ctrl+Alt+Del, lock screen) | No border, no hook. [INFERENCE]: the agent's medium-integrity injection cannot reach that desktop either. | O:263 |
| **Multiple displays, add/remove, DPI change** | One overlay per display, rebuilt on change. | O:109-111, O:264: **UNPROVEN** on a one-monitor host |
| **RDP view of the protected overlay** | Settled by the person's checkpoint step (§9). | O:128-129 |
| **Injected ESC from accessibility tools** (on-screen keyboard, remappers) | Counted as injected, so it does not kill. Only a hardware or RDP-client key kills. | [INFERENCE] from O:152-154, O:250-252 |

## 8. DM client descriptor in the controlling chat

DM-1118 gave GUI Skitarii chats the same generation-scoped DM client descriptor terminal launches get
(`src/main/terminals/terminalEnv.ts:13`; `src/main/agentChat/agentChatSessions.ts:837-846`). A controlling chat
therefore keeps its native `dm_call`, `recover_tooling` and mail tools (sprint exit x6). The build sprint relies on
that: its agents and e2e use native `dm_call` in GUI chats, and nothing in this design changes the descriptor. The
§5.6 lock does not touch those tools, because human-only capabilities are never in any grant (`src/core/authz.ts:94-95`).

## 9. Unattended verification strategy

Everything is checked by an agent on the Windows host except one physical keypress.

1. **Fake computer-use persona** in `src/main/agentChat/__fixtures__/fakeAgentCli.mjs`, an OMP persona switch beside
   `FAKE_AGENT_PERSONA` (`:26-29`). It is built from the committed redacted RPC fixture
   `docs/reports/desktop-control-backend/omp-computer-use.rpc.redacted.jsonl` (B:148-155). It:
   - answers `/computer status` and `get_state` with the enabled or disabled signature (B:136-137), depending on
     whether its `--config` file contains `computer:\n  enabled: true`. This proves main wrote the overlay rather than
     faking the answer;
   - on a scripted prompt, replays the fixture's `eval` `tool_execution_*` frames;
   - really drives the fixture window: a `SendInput` click, the text "hello" and an **injected** Escape, using the
     probe's `inject.ps1` route (O:162) after a foreground check;
   - writes one `omp-computer-1.png` into its `TEMP`, for §5.7.
2. **Fixture desktop window:** the DM-1041 Electron fixture (`scripts/spike/desktop/fixture.electron.cjs`), which logs
   clicks, text and every `keydown` with `isTrusted` to a state file (B:33-38). It is promoted to
   `scripts/desktop-fixture.electron.cjs` (new) for the built-app steps.
3. **Built-app e2e steps** in `scripts/e2e-agent-chat.mjs`, beside its `STEPS` (`:3822-3874`), with zero retries:
   - `desktop-enable`: the overlay is present (window list, topmost, affinity `0x11`) and the header badge is on;
   - `desktop-drive`: the agent drives the fixture, which reads back `clicks`, `text` and `Escape` (`isTrusted: true`);
   - `desktop-injected-esc`: injected ESC does not kill, and the badge and overlay stay;
   - `desktop-lock`: Approve, Kick back, Delete and site Allow are refused by main with `desktop_control_active`;
   - `desktop-stop`: Stop kills, the overlay is gone in ≤ 10 ms, the tree in ≤ 150 ms, the lock is lifted and no key
     arrives after;
   - `desktop-failclosed`: kill the hook helper, and control ends with `hook-exited`;
   - `desktop-single-owner`: a second chat's enable is refused;
   - `desktop-untrack`, `desktop-quit` and `desktop-crash`: each ends control within its bound;
   - `desktop-restart-off`: a relaunch or restart resume comes back with the default overlay and the toggle Off.
4. **Capture states** in `scripts/capture-agent-chat.mjs` (`STATES`, `:22-39`), at 1024×768 and 1440×900:
   - header Off, Starting, On and Ended (fail-closed);
   - the tree row lock;
   - a locked checkpoint gate, a locked Kanban card panel and a locked origin prompt.

   The reviewer opens every PNG.
5. **Live-facts probe** (real omp, bounded): settles the remaining backend facts before the dependent tickets build on
   them. These are `TEMP` redirection (§5.7), resume-with-default-overlay (§3.4) and job-kill timing (§6.2).
6. **One person step at the checkpoint.** In the packaged build, the person turns on Desktop control for a chat. They
   look for the border on every display, which settles RDP visibility of the protected overlay (§5.1), then press
   **Esc** on the physical keyboard. Control ends and the border disappears. This is the only human step.

## 10. Risks and limits, stated plainly

- **Total control can damage the machine.** While control is on, the agent has the person's mouse, keyboard and
  screen. It can delete files, send messages and run anything the person could. The person accepted this
  (2026-11-26). Nothing here contains it.
- **The overlay is visibility, not containment.** It shows that control is on. It does not limit what the agent does,
  and it can be hidden by exclusive fullscreen and the secure desktop (§7).
- **Kill races.** Input the agent queued before the kill can land in the first ~150 ms (O:201-204).
- **The lock protects DM's window only** (§5.6). An agent can still type into another app or terminal the person left
  open.
- **One owner per DM process.** A second DM instance (another isolated profile) is not prevented from enabling
  control at the same time (§4).
- **UNPROVEN, each with its build-sprint test** (see the proposal):
  - the physical ESC press, its callback-to-overlay time, and the OMP and DM stops firing together (O:256-257);
  - RDP visibility of the protected overlay (O:265);
  - resume with the default overlay reporting disabled (§3.4);
  - OMP honouring `TEMP` for its screenshots (§5.7);
  - inline rendering of desktop screenshots (B:56);
  - the DM-crash → OMP-tree-ended chain for real OMP (§6.2);
  - the Stop IPC hop (§6.2);
  - ping-loss detection (§6.2);
  - multi-monitor, add/remove and DPI (O:264);
  - elevated windows and exclusive fullscreen (O:258-262): observable only with a UAC prompt or a particular app, so
    they stay documented limits;
  - whether held control (`computer.control.acquire` with `tools.approval: { computer.control: allow }`) is needed
    (B:122-124, B:237-238). It is retired by decision: DM never sets `tools.approval`. Per-call takeover covered every
    action in the probe (B:124), and a unit test pins that the overlay contains no `tools.approval`;
  - the extra `Unidentified` keydown (B:89-90): it stays a known oddity and is asserted harmless (text unchanged) by
    `desktop-drive`.
