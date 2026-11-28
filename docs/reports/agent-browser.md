# In-app agent browser: Electron 42 probe on the Windows host, and the agent interface

Recorded on 2026-11-27 for the agent-chat epic, Sprint 4 (ticket DM-851), on the execution host. It holds the GO/NO-GO evidence for each Electron behaviour the browser tickets rely on, and confirms (with amendments) the agent interface. No product code changed.

## How it was run, and the limits of this report

- **Code:** branch `work2/dm-851`, started from `origin/sprint/agent-gui-s4` at `d6831c07`. The throwaway probe is `scripts/spike/browser-probe.mjs` (launcher) and `scripts/spike/browser-probe.electron.cjs` (Electron main). No product code imports either.
- **Runtime:** the repo's own Electron, `electron` 42.11.18 (Chrome 148.0.7778.280, Node 24.19.0), on Windows 10.0.26200, x64.
- **Display:** one display at 150% scaling (scale factor 1.5, `AppliedDPI` 144). Display settings were never changed, so the 100% case is **UNTESTED** (Fix 56).
- **Session:** the host runs in an RDP session (`query user`: `rdp-tcp#0`, session 2, Active), and the session's desktop was not being drawn during the runs:
  - GDI `CopyFromScreen` from a plain PowerShell failed with `The handle is invalid`;
  - from the probe it returned a single-colour (white) image;
  - `desktopCapturer` listed 1 window source (not the probe's window) and a 0×0 screen thumbnail.

  Everything that needs the composited screen (the on-screen look in items 7 and 8) is therefore **UNTESTED on screen**, and is marked so below. Chromium's own page captures (`capturePage`) work regardless.
- **Isolation of the run:**
  - The launcher filters the environment as `scripts/first-prompt-smoke.mjs:30` does, dropping `DM_SESSION_TOKEN`, `DM_DESKTOP_PIPE`, `ELECTRON_*` and `NODE_OPTIONS`.
  - Electron runs with a fresh temporary `userData` (deleted afterwards), so partition `persist:dm-browser-spike` lives only there.
  - The fixtures are two `node:http` servers on `127.0.0.1:0`.
  - No credentials, personal browsing, native or global input were used. `use-fake-device-for-media-stream` is set because the host has no microphone (see item 5).
- **Rerun:** `node scripts/spike/browser-probe.mjs --out <dir>`. It prints one record per item, writes `probe-output.json` and the PNGs to `<dir>`, and exits 0 only when Electron ran all 8 items. It takes about 40 s.
- **Runs and timing:** the probe was run 4 times while it was being written; runs 1–3 exposed probe bugs that were fixed. The output pasted at the end is run 4, the committed code, unchanged since. Item 3's hidden-view capture differed between run 3 (stale frame) and run 4 (fresh frame); see item 3. The times are single-run wall-clock figures on a heavily loaded host: indicative, not benchmarks.

## Results

| # | Item | Verdict | Time (run 4) |
|---|------|---------|--------------|
| 1 | Debugger: AX tree, box model, click, type, Enter | **GO** | 70 ms total; each CDP call ≤ 4 ms |
| 2 | Detach, in-flight command, re-attach, DevTools | **GO** | 4.3 s (includes deliberate 3–4 s waits) |
| 3 | `capturePage` visible / hidden / off-window | **GO for a visible view only**; hidden and off-window captures are unreliable or stale | 6–10 ms per capture; hidden window: no result in 5 s |
| 4 | Navigation events | **GO**; "`loadURL` fires none" **confirmed** for the main frame | 3.5 s |
| 5 | Isolation (schemes, popup, download, permission) | **GO** | 0.9 s |
| 6 | IPC guard | **GO** | 1 ms |
| 7 | Bounds and DPI at 150%; focus | **GO on screen** at zoom 1 and 1.25 (0 magenta pixels); 100% **UNTESTED** | 6.6 s (2026-11-28 run) |
| 8 | Overlay | **GO**: div menu, modal `<dialog>` and fixed toast render **under** the view; the `<select>` picker renders **over** it | 10.3 s (2026-11-28 run) |

None of the items is a NO-GO. Item 7's 100% case is UNTESTED, and item 3 limits where screenshots can be taken. The orchestrator should decide on these before dependent tickets are claimed (see "For the Magos").

**History of items 7 and 8.** Every run before 2026-11-28 had a blank RDP desktop, so their on-screen checks were UNTESTED. The first run with the desktop drawn captured the person's own topmost Dark Mechanicus window instead of the probe window: it gave a false item-7 NO-GO and an item-8 "GO" built on four inconclusive cases. The probe now raises its window (`raise(win)`: `setAlwaysOnTop(true, 'screen-saver')`, `moveTop`, `focus`) before reading screen pixels, and item 8 reports INCONCLUSIVE when any case is. Items 7 and 8 below are from the 2026-11-28 rerun on 923cfc98 plus that fix, desktop drawn, host at 150%.

### 1. Debugger

**Attach and devTools.** `webContents.debugger.attach('1.3')` took 0.6 ms. A second view created with `webPreferences.devTools: false` still attached, and `Runtime.evaluate('6 * 7')` returned 42. **So `devTools:false` does not block `debugger.attach`.**

**AX tree.** `Accessibility.getFullAXTree` took 4 ms and returned 17,603 bytes and 41 nodes for the fixture page. After typing it returned 19,257 bytes and 45 nodes. The tree is per document: the iframe's content is not in the main frame's tree.

**Box model.** `DOM.getBoxModel({ backendNodeId })` worked from the AX node's `backendDOMNodeId` without a prior `DOM.getDocument` (`firstCallError: null`), in 0.4 ms.

**Click.** An `Input.dispatchMouseEvent` press and release at the box centre changed the heading to `clicked`, in 2.4 ms.

**Typing.** `DOM.focus` plus `Input.insertText` set the input to `hello probe`, in 2 ms.

**Enter.** An `Input.dispatchKeyEvent` keyDown and keyUp for `Enter` reached the page's `keydown` listener (`keys: "Enter;"`), in 1.2 ms.

**Password.** The AX tree does **not** expose the password value. Neither the `value` attribute secret nor the typed secret appears anywhere in either tree's JSON. However, the password node (role `textbox`) carries `value: "•••…"`, **one bullet per character (41 bullets for 41 characters)**, so the tree leaks the password's length. `browser_read` must drop the value of any password field (and should drop all `value`s of `protected` or password nodes), not pass the AX value through.

**GO list.** The CDP commands the agent driver (`src/main/browser/browserDriver.ts`) may send: `Accessibility.getFullAXTree`, `DOM.getBoxModel`, `Input.dispatchMouseEvent`, `DOM.focus`, `Input.insertText` and `Input.dispatchKeyEvent`, all measured above, plus two read-only DOM commands added by the browser service ticket (DM-866): `DOM.describeNode`, because the AX tree carries no password marker, and `DOM.scrollIntoViewIfNeeded`, before a click.

### 2. Detach

- **`detach()`:** returned in 0.3 ms. The `detach` event **did** fire for a programmatic detach, with reason `"target closed"`, 0.4 ms after the call.
- **In flight:** a `Runtime.evaluate` awaiting a 3 s promise **rejected** with `No target available`, 0.4 ms after `detach()`. It did not hang until the promise settled.
- **Re-attach:** worked, and `Runtime.evaluate('1 + 1')` returned 2.
- **DevTools opened by the person:** `openDevTools({ mode: 'detach' })` while attached emitted `devtools-opened` after 271 ms. **No `detach` event** followed within 4 s, `isAttached()` stayed true, and `Runtime.evaluate('2 + 2')` still returned 4. Chromium serves both clients, so DevTools does not kick the agent off. If the panel wants "the person is inspecting" to pause the agent, it must react to `devtools-opened` itself. The agent view can simply set `devTools: false`, which leaves `debugger.attach` working (item 1).

### 3. Capture

`webContents.capturePage()` of the view. Bounds 641×401 DIP at scale 1.5. Each case first repainted the page in its own colour, so a fresh frame can be told from a cached one.

| Case | `isEmpty()` | PNG bytes | Size (px) | Expected round(DIP × 1.5) ±1 | Frame |
|---|---|---|---|---|---|
| visible | false | 18,760 | 962×602 | 962×602, matches | fresh (547,713 px of the case colour) |
| `setVisible(false)` | false | 18,363 | 962×602 | matches | **fresh in run 4 (548,424 px), stale in run 3 (362 px, the previous frame)** |
| off-window bounds (x = y = 5000) | false | 18,363 | 962×602 | matches | **stale** (7 px; the PNG shows the previous case's blue page) |
| window hidden (`win.hide()`) | — | — | — | — | **no result within 5 s** |

Both values the verdict needs are recorded, the device size and round(DIP bounds × `screen.getDisplayMatching(bounds).scaleFactor`) (Fix 56). **So `capturePage` is only reliable on a visible, on-window view.** On a hidden view it returns whatever frame was last produced: fresh in one run and stale in another. Off-window it returns a stale frame, and with the window hidden it does not answer. `browser_screenshot` must therefore:
- answer only while the view is shown and on-window, and otherwise refuse with a clear error (for example `browser_hidden`);
- or briefly show the view, wait for a new frame and capture it, with a bounded wait.

It must never return a hidden view's capture as current.

### 4. Navigation events

These are the `will-*` events observed on the view's `webContents` (`main`/`sub` is the frame).

| Trigger | `will-navigate` | `will-redirect` | `will-frame-navigate` | Other |
|---|---|---|---|---|
| main-process `loadURL` (page with an iframe) | — | — | sub, the iframe's `/frame` only | `did-start-navigation` ×2 |
| link click inside the iframe | — | — | sub `/frame2` | `did-start-navigation` |
| link click (main frame) | main `/page2` | — | main `/page2` | `did-start-navigation` |
| link to a 302 to http (other origin) | main `/redirect-http` | main `…/landing` | main `/redirect-http` | `did-redirect-navigation` |
| link to a 302 to `file:///C:/Windows/win.ini` | main `/redirect-file` | **—** | main `/redirect-file` | `did-fail-load -311 ERR_UNSAFE_REDIRECT`; `file:` never committed |
| main-process `loadURL` (other origin, http) | — | — | — | `did-start-navigation` |
| main-process `loadURL('file:///C:/Windows/win.ini')` | — | — | — | `did-start-navigation`; **the `file:` URL committed** |

What this means for the browser tickets:
- **`loadURL` fires none of the three `will-*` events for its main frame.** The expectation is confirmed. Main must apply the origin policy (scheme allow-list `http:`/`https:`, plus the person's origin approval) **before** calling `loadURL`. The last row shows why: the partition view loads a `file:` URL when main asks it to. Subframes that the loaded page creates do fire `will-frame-navigate`.
- A renderer link click fires both `will-navigate` and `will-frame-navigate` for the main frame. Iframe navigations fire only `will-frame-navigate`.
- An http→http redirect fires `will-redirect`. An http→`file:` redirect never reaches `will-redirect`: Chromium blocks it first (`ERR_UNSAFE_REDIRECT`).
- To gate a renderer-initiated top-level navigation, guard `will-navigate` (or `will-frame-navigate` filtered to `isMainFrame`) **and** `will-redirect`, as `hardenWebContents` already does for the main window. Gating subframes needs `will-frame-navigate`. `did-start-navigation` fires for everything, `loadURL` included, but it is not cancellable, so it can only be a log or backstop.

### 5. Isolation

- **Scheme stubs.** A stub registered `protocol.handle` on the default session for both of the app's schemes, `dm-attachment` (named in the ticket) and `dm-chat-image`, made privileged with `standard, secure` as `src/main/desktop/attachmentProtocol.ts:111` does. `protocol.isProtocolHandled` was true for both on the default session and **false for both in the partition session**.
- **Page requests from the partition.** A page `fetch('dm-attachment://x/y')` (and `dm-chat-image://x/y`) **rejected** (`Failed to fetch`), an `<img>` load failed, and the stub's hit counter stayed at **0**.
- **Control from the default session.** The same requests from a view in the default session also failed in the page: the stub answers with text, and the scheme lacks `supportFetchAPI`. But they **reached the stub (1 hit)**. Requests from the partition never reach the app's handlers.
- **Popup.** `setWindowOpenHandler` returning `{ action: 'deny' }` blocked `window.open('/popup')`. The handler saw the URL, the window count stayed 1 → 1, and `did-create-window` never fired.
- **Download.** `item.cancel()` in the partition's `will-download` stopped `/download`: state `cancelled`, 0 bytes received, and the page stayed put.
- **Permission.** A deny from the partition's `setPermissionRequestHandler` refused `navigator.mediaDevices.getUserMedia({ audio: true })` with `NotAllowedError: Permission denied`, and the handler saw `media` with `mediaTypes: ["audio"]`.

  Without fake devices, Chromium answered `NotFoundError: Requested device not found` *before* asking the handler (run 1, because the host has no microphone). The probe therefore sets `use-fake-device-for-media-stream` so that the request reaches the handler.

### 6. IPC guard

**Globals in the view.** In the view, `typeof require`, `process`, `ipcRenderer` and `window.electron` are all `undefined`, and no `electron`/`ipc`/`dm` globals exist. With no preload, there is nothing to call IPC with.

**The guard.** The launcher also ran the view's top-level frame URL (`http://127.0.0.1:<port>/`) through the app's own `isTrustedSender` (`src/main/ipcGuard.ts:33`, which `guardIpc` at :64 applies), bundled with esbuild. It is **not trusted** against either app URL: `http://localhost:5173/` (dev) and the packaged `file:///…/out/renderer/index.html`. `guardIpc` would refuse its calls anyway.

### 7. Bounds, DPI and focus

**Scaling.** The host runs at **150%** (scale 1.5). The 100% case is **UNTESTED**: the host is not at 100%, and display settings are never changed (Fix 56).

**Placement.** The view's bounds are the placeholder's renderer rect × the host `getZoomFactor()`, rounded to DIP:

| Zoom | Renderer rect (CSS px) | View bounds (DIP) | View device px | Offset in host capture (device px) |
|---|---|---|---|---|
| 1 | 37, 93, 641×401 | 37, 93, 641×401 | 962×602 | 56, 140 |
| 1.25 | 37, 93, 641×401 | 46, 116, 801×501 | 1202×752 | 69, 174 |

**Alignment.** **GO on screen** (2026-11-28 run). The probe captured the raised window from the drawn desktop and counted magenta placeholder pixels, with a 1-device-pixel fringe allowance (limits 3,126 at zoom 1 and 3,906 at zoom 1.25): **0 magenta** at both zooms, with 546,062 and 870,842 view-green device pixels. The simulated composite (the view's capture pasted at bounds × scale over the host's capture) also left 0 magenta at both zooms.

**Focus** (same in the 2026-11-28 run). The composer textarea in the host page was focused first, with the window focused.
- `webContents.sendInputEvent` (a synthetic Electron mouse click on the view; no OS input was sent): the composer kept focus. The view's `webContents.isFocused()` stayed false and its `document.hasFocus()` stayed false.
- CDP `Input.dispatchMouseEvent` click on the view: the composer **kept** focus (`activeElement` composer, host `webContents.isFocused()` true). Inside the view, `document.hasFocus()` became true (CDP emulates focus for the target page), but the view's `webContents` never took native focus.
- CDP `Input.insertText`: the composer kept focus; the view's `webContents` still had no native focus.
- **So agent-driven CDP input does not steal the composer's keyboard focus.** Whether a *real* mouse click on the view moves native focus to it is **UNTESTED**: it would need OS input on the person's desktop, which this probe never sends. [INFERENCE] A real click focuses the view, as with any Chromium view; the Take control UI should rely on that and return focus to the composer on Hand back.

### 8. Overlay

Each of four renderer elements was opened in the host page, inside the area the view covers, and the window was captured with the view shown and hidden:
- an absolutely positioned menu `div`;
- a modal `<dialog>` (top layer);
- a `position: fixed` toast;
- a `<select>` opened with `showPicker()`.

**On screen: GO** (2026-11-28 run). Device pixels of each element's colour, in the host page's own capture / on screen with the view shown / on screen with the view hidden:

| Element | Host capture | View shown | View hidden | Result |
|---|---|---|---|---|
| menu `div` | 54,000 | 2,181 | 54,000 | **under** the view |
| modal `<dialog>` | 53,032 | 0 | 53,032 | **under** the view |
| `position: fixed` toast | 16,875 | 0 | 16,875 | **under** the view |
| `<select>` picker | 51,579 | 51,579 | 51,579 | **over** the view |

The probe's classifier labels the menu "renders over the view" because some pixels remain; 96% of it disappears when the view is shown. [INFERENCE] The 2,181 remaining pixels are the part of the menu outside the view's bounds, so the menu renders under the view.

So everything drawn in the page's surface, including the top-layer `<dialog>`, renders under the native view. The `<select>` picker opened with `showPicker()` is a separate popup widget and renders over it. The earlier inference that the open `<select>` list renders underneath was wrong. Native OS menus (`Menu.popup`) and OS dialogs are separate windows and also draw above.

Design rule for the panel: hide the view (`setVisible(false)`) whenever a renderer dialog, menu, picker or toast may overlap the Browser tab, and show it again afterwards. Gap recorded at the DM-871 review: toasts do not register with `overlays.ts`, so today a toast over the Browser tab is hidden by the view.

## Agent interface

What the code says today:
- **`createControlPipe`** (`src/main/naming/controlPipe.ts:293`; the ticket's `:268` now falls inside `ControlOperation`) builds a `ControlServer` that is naming-specific throughout. It uses `namingRequestSchema`, `namingFailure` and `NamingErrorCode`, and the `NAMING_CONTROL` limits: `connections: 32`, `queuedPerChat: 8` (one active operation per chat lane), `serverMs: 20_000`, `clientMs: 25_000`, and `responseBytes: 8192`. Its address is `\\.\pipe\dm-desktop-<uuid>` on Windows. The comment says Windows pipe ACLs are not user-exclusive, so authority comes from the grant token and capability, never from the address.
- **`NAMING_CONTROL`** (`src/shared/agents/chatNaming.ts:5-9`) spreads `DESKTOP_CONTROL_LIMITS`, which `resources/skitarii/extension/controlLimits` shares with the extension: `requestBytes 32_768, namingRequestBytes 4096, responseBytes 8192, credentialBytes 4096`. Its comment reads "Generation-bound local desktop control; each operation has its own server-side authority".
  - **Amendment to the ticket's premise:** the comment does not say "Naming metadata only", and the pipe is already not naming-only. It also carries `recover_tooling`, authorized by `tooling.recover` (`controlPipe.ts:236-245`, `NamingControlBinding.assertRecovery`/`verifyAuthority('chat.name' | 'tooling.recover')`).
- **`desktopClient.ts`** reads `DM_DESKTOP_PIPE` (:22) and opens one connection per request, with no retry (`createDesktopClient`, :90-91; the ticket's `:82` is inside `transport`, :44).

What the probe measured that bears on the wire:
- The fixture page's AX tree alone is 17.6–19.3 KB, more than twice the naming pipe's 8 KiB reply.
- A 962×602 PNG of a flat page is 18.4–18.8 KB. Real pages are far larger in both.

**Decision: confirmed, with three amendments.**
1. **A second control pipe, from a generalized control server (`s3-ctlpipe`): confirmed.** The lane, queue, deadline, framing and generation logic in `ControlServer` is reused, with the request and reply schemas, error codes and limits made parameters.
2. **Its own address env, `DM_BROWSER_PIPE`: confirmed.** It is set by `chatGrants.withGrant` only when the live grant holds `browser.drive`. It is stripped wherever `DM_DESKTOP_PIPE` is stripped (`terminalEnv.ts` `NEVER_PASSED`, `first-prompt-smoke.mjs`, this probe).
3. **`browser.drive` on the live chat grant: confirmed.** It is checked per operation, like `chat.name`/`tooling.recover`, re-verified against the store before and after the operation, and absent from worker and reviewer grants unless the plan grants it.
4. **A 64 KiB response limit: confirmed for `browser_read`/`browser_status`, amended for `browser_screenshot`.**
   - `browser_read` returns a compact projection of the AX tree (role, name, a stable ref, interactive state), never the raw tree. It omits every password or protected field's `value`, because the AX value leaks the length (item 1). It truncates to the limit with an explicit `truncated` marker.
   - `browser_screenshot` does **not** put image bytes in the reply: a screenshot of a real page exceeds 64 KiB. Main stores the PNG as a chat image or staged attachment and the reply carries its id and pixel size. It captures only a visible, on-window view (item 3).
   - The browser server also needs its own deadlines. Navigation waits for load, which can exceed the naming pipe's 20 s server bound on slow sites. Its bounds are declared on the browser server, not borrowed from `NAMING_CONTROL`.
5. **The naming pipe stays as it is:** naming plus the narrow tooling-recovery repair, never browser operations.

**Alternative considered: widening the naming pipe** (add the `browser_*` operations to `namingOperationSchema`, and raise `responseBytes`). **Rejected:**
- `responseBytes` is the shared `DESKTOP_CONTROL_LIMITS` constant the extension also reads, and its comment promises that larger bodies "never enlarge naming or credential authority". Raising it to 64 KiB for every naming and recovery reply widens a channel that every chat with `chat.name` holds.
- Every chat that can name itself would receive the pipe address that drives the browser, so least privilege would rest on the per-operation check alone. A separate address is only handed to chats holding `browser.drive`.
- Browser operations are long-running, and their failures (navigation, consent pending, hidden view) differ from naming's metadata mutations. Folding them into the naming lane would make a page load block a chat's rename queue (`queuedPerChat: 8`), and the reverse.
- A second instance of a generalized server costs one more listener and env var. It reuses the tested framing and generation fencing, so the extra code is the schemas.

## For the Magos (decisions before dependent tickets)

- **Item 3:** decide `browser_screenshot`'s behaviour on a hidden or off-window view: refuse, or show briefly and capture. Hidden and off-window captures are stale or nondeterministic, and with the window hidden there was no result in 5 s.
- **Item 7:** on-screen alignment is GO at 150%; 100% scaling is UNTESTED (host at 150%, display settings never changed), and so is the real-click focus case (the probe sends no OS input).
- **Item 8:** GO, measured on screen. Toasts must register with `overlays.ts` so the view hides under them (DM-871 review gap).
- **Interface amendments:**
  - `browser_screenshot` returns an attachment reference, not bytes;
  - `browser_read` returns a trimmed projection that drops password values;
  - the browser server has its own deadlines;
  - the "naming only" premise is corrected: the naming pipe already carries `recover_tooling`.

## Probe output (run 4, the committed probe)

The complete stdout and stderr of `node scripts/spike/browser-probe.mjs --out C:\Users\davgo\dmwork\probe851-run4`. The first two lines are Electron's own warning for the blocked `file:` redirect (item 4).

```text
(node:11880) electron: Failed to load URL: http://127.0.0.1:53389/redirect-file with error: ERR_UNSAFE_REDIRECT
(Use `electron --trace-warnings ...` to show where the warning was created)

## Item 0: Environment -> n/a (0 ms)
{
  "electron": "42.11.18",
  "chrome": "148.0.7778.280",
  "node": "24.19.0",
  "platform": "win32",
  "osRelease": "10.0.26200",
  "scaleFactor": 1.5,
  "fixtureOrigins": [
    "http://127.0.0.1:53389",
    "http://127.0.0.1:53388"
  ]
}

## Item 1: Debugger -> GO (70 ms)
{
  "timingsMs": {
    "attach": 0.4,
    "Accessibility.getFullAXTree": 2.9,
    "DOM.getBoxModel": 0.3,
    "Input.dispatchMouseEvent click": 2.1,
    "DOM.focus + Input.insertText": 1.7,
    "Input.dispatchKeyEvent Enter": 0.9
  },
  "axTree": {
    "bytes": 17603,
    "nodes": 41
  },
  "axTreeAfterTyping": {
    "bytes": 19257,
    "nodes": 45
  },
  "boxModel": {
    "x": 64.93229293823242,
    "y": 88.16666793823242,
    "width": 114,
    "height": 21,
    "firstCallError": null
  },
  "page": {
    "heading": "clicked",
    "text": "hello probe",
    "keys": "Enter;",
    "passwordLength": 41
  },
  "password": {
    "exposed": false,
    "leaked": [],
    "role": "textbox",
    "value": {
      "type": "string",
      "value": "•••••••••••••••••••••••••••••••••••••••••"
    },
    "properties": [
      "invalid",
      "focusable",
      "focused",
      "editable",
      "settable",
      "multiline",
      "readonly",
      "required"
    ]
  },
  "devToolsFalse": {
    "attached": true,
    "attachError": null,
    "evaluate6x7": 42
  }
}

## Item 2: Detach -> GO (4321.8 ms)
{
  "detachCallMs": 0.4,
  "detachEventOnDetach": {
    "reason": "target closed",
    "ms": 0.6
  },
  "inFlight": {
    "rejected": true,
    "error": "No target available",
    "settledMs": 0.5
  },
  "reattached": true,
  "reattachError": null,
  "devToolsOpened": {
    "devtoolsOpenedMs": 261.1,
    "detachEvent": "not emitted within 4000 ms",
    "isAttachedAfterOpen": true,
    "commandAfterOpen": 4,
    "attachWhileOpen": "already attached"
  }
}

## Item 3: Capture -> GO (7501.9 ms)
{
  "cases": [
    {
      "label": "visible",
      "ms": 5.3,
      "isEmpty": false,
      "pngBytes": 18760,
      "size": {
        "width": 962,
        "height": 602
      },
      "viewDipBounds": {
        "x": 37,
        "y": 93,
        "width": 641,
        "height": 401
      },
      "scaleFactor": 1.5,
      "expectedDeviceSize": {
        "width": 962,
        "height": 602
      },
      "sizeMatches": true,
      "freshPixels": 547713,
      "fresh": true
    },
    {
      "label": "view-setVisible-false",
      "ms": 10.5,
      "isEmpty": false,
      "pngBytes": 18363,
      "size": {
        "width": 962,
        "height": 602
      },
      "viewDipBounds": {
        "x": 37,
        "y": 93,
        "width": 641,
        "height": 401
      },
      "scaleFactor": 1.5,
      "expectedDeviceSize": {
        "width": 962,
        "height": 602
      },
      "sizeMatches": true,
      "freshPixels": 548424,
      "fresh": true
    },
    {
      "label": "off-window-bounds",
      "ms": 9.5,
      "isEmpty": false,
      "pngBytes": 18363,
      "size": {
        "width": 962,
        "height": 602
      },
      "viewDipBounds": {
        "x": 5000,
        "y": 5000,
        "width": 641,
        "height": 401
      },
      "scaleFactor": 1.5,
      "expectedDeviceSize": {
        "width": 962,
        "height": 602
      },
      "sizeMatches": true,
      "freshPixels": 7,
      "fresh": false
    },
    {
      "label": "window-hidden",
      "ms": 5011.8,
      "error": "still pending after 5000 ms"
    }
  ]
}

## Item 4: Navigation events -> GO (3483.5 ms)
{
  "checks": {
    "linkGuarded": true,
    "redirectGuarded": true,
    "fileNeverCommits": true,
    "frameGuarded": true,
    "loadUrlMainFrameFiresNoWillEvent": true,
    "mainProcessFileLoadCommits": true
  },
  "expectationLoadUrlFiresNone": "confirmed",
  "scenarios": [
    {
      "scenario": "main-process loadURL (initial page, with iframe)",
      "fired": {
        "will-navigate": [],
        "will-redirect": [],
        "will-frame-navigate": [
          "sub http://127.0.0.1:53388/frame"
        ]
      },
      "finalUrl": "http://127.0.0.1:53389/",
      "events": [
        {
          "scenario": "main-process loadURL (initial page, with iframe)",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53389/",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "main-process loadURL (initial page, with iframe)",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53388/frame",
          "isMainFrame": false,
          "args": [
            "http://127.0.0.1:53388/frame",
            false,
            false,
            5
          ]
        },
        {
          "scenario": "main-process loadURL (initial page, with iframe)",
          "event": "will-frame-navigate",
          "url": "http://127.0.0.1:53388/frame",
          "isMainFrame": false,
          "args": [
            "http://127.0.0.1:53388/frame",
            false,
            false,
            5
          ]
        }
      ]
    },
    {
      "scenario": "iframe link click",
      "fired": {
        "will-navigate": [],
        "will-redirect": [],
        "will-frame-navigate": [
          "sub http://127.0.0.1:53388/frame2"
        ]
      },
      "finalUrl": "http://127.0.0.1:53389/",
      "events": [
        {
          "scenario": "iframe link click",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53388/frame2",
          "isMainFrame": false,
          "args": [
            "http://127.0.0.1:53388/frame2",
            false,
            false,
            5
          ]
        },
        {
          "scenario": "iframe link click",
          "event": "will-frame-navigate",
          "url": "http://127.0.0.1:53388/frame2",
          "isMainFrame": false,
          "args": [
            "http://127.0.0.1:53388/frame2",
            false,
            false,
            5
          ]
        }
      ],
      "triggerError": null
    },
    {
      "scenario": "link click",
      "fired": {
        "will-navigate": [
          "main http://127.0.0.1:53389/page2"
        ],
        "will-redirect": [],
        "will-frame-navigate": [
          "main http://127.0.0.1:53389/page2"
        ]
      },
      "finalUrl": "http://127.0.0.1:53389/page2",
      "events": [
        {
          "scenario": "link click",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53389/page2",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/page2",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link click",
          "event": "will-frame-navigate",
          "url": "http://127.0.0.1:53389/page2",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/page2",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link click",
          "event": "will-navigate",
          "url": "http://127.0.0.1:53389/page2",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/page2",
            false,
            true,
            5
          ]
        }
      ],
      "triggerError": null
    },
    {
      "scenario": "link to a 302 to http",
      "fired": {
        "will-navigate": [
          "main http://127.0.0.1:53389/redirect-http"
        ],
        "will-redirect": [
          "main http://127.0.0.1:53388/landing"
        ],
        "will-frame-navigate": [
          "main http://127.0.0.1:53389/redirect-http"
        ]
      },
      "finalUrl": "http://127.0.0.1:53388/landing",
      "events": [
        {
          "scenario": "link to a 302 to http",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53389/redirect-http",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/redirect-http",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to http",
          "event": "will-frame-navigate",
          "url": "http://127.0.0.1:53389/redirect-http",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/redirect-http",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to http",
          "event": "will-navigate",
          "url": "http://127.0.0.1:53389/redirect-http",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/redirect-http",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to http",
          "event": "will-redirect",
          "url": "http://127.0.0.1:53388/landing",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53388/landing",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to http",
          "event": "did-redirect-navigation",
          "url": "http://127.0.0.1:53388/landing",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53388/landing",
            false,
            true,
            5
          ]
        }
      ],
      "triggerError": null
    },
    {
      "scenario": "link to a 302 to file:",
      "fired": {
        "will-navigate": [
          "main http://127.0.0.1:53389/redirect-file"
        ],
        "will-redirect": [],
        "will-frame-navigate": [
          "main http://127.0.0.1:53389/redirect-file"
        ]
      },
      "finalUrl": "http://127.0.0.1:53389/redirect-file",
      "events": [
        {
          "scenario": "link to a 302 to file:",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53389/redirect-file",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/redirect-file",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to file:",
          "event": "will-frame-navigate",
          "url": "http://127.0.0.1:53389/redirect-file",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/redirect-file",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to file:",
          "event": "will-navigate",
          "url": "http://127.0.0.1:53389/redirect-file",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53389/redirect-file",
            false,
            true,
            5
          ]
        },
        {
          "scenario": "link to a 302 to file:",
          "event": "did-fail-load",
          "url": null,
          "isMainFrame": null,
          "args": [
            -311,
            "ERR_UNSAFE_REDIRECT",
            "http://127.0.0.1:53389/redirect-file",
            true
          ]
        }
      ],
      "triggerError": null
    },
    {
      "scenario": "main-process loadURL (cross-origin http)",
      "fired": {
        "will-navigate": [],
        "will-redirect": [],
        "will-frame-navigate": []
      },
      "finalUrl": "http://127.0.0.1:53388/landing",
      "events": [
        {
          "scenario": "main-process loadURL (cross-origin http)",
          "event": "did-start-navigation",
          "url": "http://127.0.0.1:53388/landing",
          "isMainFrame": true,
          "args": [
            "http://127.0.0.1:53388/landing",
            false,
            true,
            11
          ]
        }
      ],
      "triggerError": null
    },
    {
      "scenario": "main-process loadURL (file:)",
      "fired": {
        "will-navigate": [],
        "will-redirect": [],
        "will-frame-navigate": []
      },
      "finalUrl": "file:///C:/Windows/win.ini",
      "events": [
        {
          "scenario": "main-process loadURL (file:)",
          "event": "did-start-navigation",
          "url": "file:///C:/Windows/win.ini",
          "isMainFrame": true,
          "args": [
            "file:///C:/Windows/win.ini",
            false,
            true,
            12
          ]
        }
      ],
      "triggerError": null
    }
  ]
}

## Item 5: Isolation -> GO (948.3 ms)
{
  "handled": [
    {
      "scheme": "dm-attachment",
      "defaultSession": true,
      "partition": false
    },
    {
      "scheme": "dm-chat-image",
      "defaultSession": true,
      "partition": false
    }
  ],
  "partitionRequests": [
    {
      "url": "dm-attachment://x/y",
      "result": {
        "fetch": "rejected: Failed to fetch",
        "img": "error"
      }
    },
    {
      "url": "dm-chat-image://x/y",
      "result": {
        "fetch": "rejected: Failed to fetch",
        "img": "error"
      }
    }
  ],
  "handlerHitsFromPartition": 0,
  "defaultSessionControl": {
    "result": {
      "fetch": "rejected: Failed to fetch",
      "img": "error"
    },
    "handlerHits": {
      "dm-attachment": 1,
      "dm-chat-image": 0
    }
  },
  "popup": {
    "handlerSaw": [
      "http://127.0.0.1:53389/popup"
    ],
    "windowsBefore": 1,
    "windowsAfter": 1,
    "didCreateWindow": 0
  },
  "download": {
    "downloads": [
      {
        "url": "http://127.0.0.1:53389/download",
        "filename": "probe.bin",
        "state": "cancelled",
        "receivedBytes": 0
      }
    ],
    "pageUrlAfter": "http://127.0.0.1:53389/"
  },
  "getUserMedia": "NotAllowedError: Permission denied",
  "permissionRequests": [
    {
      "permission": "media",
      "mediaTypes": [
        "audio"
      ]
    }
  ]
}

## Item 6: IPC guard -> GO (1.2 ms)
{
  "globals": {
    "require": "undefined",
    "process": "undefined",
    "ipcRenderer": "undefined",
    "electron": "undefined",
    "bridgeKeys": []
  },
  "senderFrame": {
    "url": "http://127.0.0.1:53389/",
    "topLevel": true
  },
  "guardIpc": [
    {
      "appUrl": "http://localhost:5173/",
      "trusted": false
    },
    {
      "appUrl": "file:///C:/Users/davgo/dmwork/dm2-851/out/renderer/index.html",
      "trusted": false
    }
  ]
}

Summary (run 4): 1=GO 2=GO 3=GO 4=GO 5=GO 6=GO; items 7 and 8 of run 4 (blank RDP desktop, UNTESTED on screen) are superseded by the 2026-11-28 run below; Electron exit 0; missing items: none
Output: C:\Users\davgo\dmwork\probe851-run4
```

## Probe output, items 7 and 8 (2026-11-28 on-screen run)

Run on 923cfc98 plus the `raise(win)` fix, with the RDP desktop drawn and the host at 150%. Only the item 7 and 8 records are shown, from `probe-output.json` in `C:\Users\davgo\dmwork\s4acc-logs\probe4`.

```text
## Item 7: Bounds, DPI and focus -> GO (6623.2 ms)
{
  "hostScaleFactor": 1.5,
  "hostScalingPercent": 150,
  "at100Percent": "UNTESTED: the host is not at 100% and display settings are never changed",
  "zooms": [
    {
      "rendererRect": {
        "x": 37,
        "y": 93,
        "width": 641,
        "height": 401
      },
      "zoomFactor": 1,
      "viewBounds": {
        "x": 37,
        "y": 93,
        "width": 641,
        "height": 401
      },
      "fringeLimit": 3126,
      "onScreen": {
        "file": "bounds-zoom-1.png",
        "deviceRect": {
          "x": 467,
          "y": 278,
          "width": 1630,
          "height": 1048
        },
        "magenta": {
          "count": 0,
          "box": null
        },
        "viewGreen": 546062
      },
      "simulated": {
        "file": "bounds-zoom-1-simulated.png",
        "hostDevicePx": {
          "width": 1629,
          "height": 1047
        },
        "viewOffsetDevicePx": {
          "left": 56,
          "top": 140
        },
        "viewDevicePx": {
          "width": 962,
          "height": 602
        },
        "magenta": {
          "count": 0,
          "box": null
        }
      }
    },
    {
      "rendererRect": {
        "x": 37.000003814697266,
        "y": 93.00000762939453,
        "width": 641.0000610351562,
        "height": 401.0000305175781
      },
      "zoomFactor": 1.25,
      "viewBounds": {
        "x": 46,
        "y": 116,
        "width": 801,
        "height": 501
      },
      "fringeLimit": 3906,
      "onScreen": {
        "file": "bounds-zoom-1.25.png",
        "deviceRect": {
          "x": 467,
          "y": 278,
          "width": 1630,
          "height": 1048
        },
        "magenta": {
          "count": 0,
          "box": null
        },
        "viewGreen": 870842
      },
      "simulated": {
        "file": "bounds-zoom-1.25-simulated.png",
        "hostDevicePx": {
          "width": 1629,
          "height": 1047
        },
        "viewOffsetDevicePx": {
          "left": 69,
          "top": 174
        },
        "viewDevicePx": {
          "width": 1202,
          "height": 752
        },
        "magenta": {
          "count": 0,
          "box": null
        }
      }
    }
  ],
  "focus": [
    {
      "name": "webContents.sendInputEvent click on the view (closest to a real click; no OS input is sent)",
      "before": {
        "windowFocused": true,
        "hostContentsFocused": true,
        "viewContentsFocused": false,
        "hostActiveElement": "composer",
        "hostHasFocus": true,
        "viewHasFocus": false
      },
      "after": {
        "windowFocused": true,
        "hostContentsFocused": true,
        "viewContentsFocused": false,
        "hostActiveElement": "composer",
        "hostHasFocus": true,
        "viewHasFocus": false
      }
    },
    {
      "name": "CDP Input.dispatchMouseEvent click on the view",
      "before": {
        "windowFocused": true,
        "hostContentsFocused": true,
        "viewContentsFocused": false,
        "hostActiveElement": "composer",
        "hostHasFocus": true,
        "viewHasFocus": false
      },
      "after": {
        "windowFocused": true,
        "hostContentsFocused": true,
        "viewContentsFocused": false,
        "hostActiveElement": "composer",
        "hostHasFocus": true,
        "viewHasFocus": true
      }
    },
    {
      "name": "CDP Input.insertText into the view",
      "before": {
        "windowFocused": true,
        "hostContentsFocused": true,
        "viewContentsFocused": false,
        "hostActiveElement": "composer",
        "hostHasFocus": true,
        "viewHasFocus": true
      },
      "after": {
        "windowFocused": true,
        "hostContentsFocused": true,
        "viewContentsFocused": false,
        "hostActiveElement": "composer",
        "hostHasFocus": true,
        "viewHasFocus": true
      }
    }
  ],
  "desktopCapturerDiagnostic": {
    "mediaSourceId": "window:428474490:1",
    "windowSources": 1,
    "listsThisWindow": true,
    "screenThumbnailSizes": [
      {
        "width": 640,
        "height": 400
      }
    ]
  }
}

## Item 8: Overlay -> GO (10276.1 ms)
{
  "cases": [
    {
      "overlay": "absolutely positioned menu (div, z-index 1000)",
      "openError": null,
      "pixelsInHostPageCapture": 54000,
      "pixelsWithViewShown": 2181,
      "pixelsWithViewHidden": 54000,
      "result": "renders over the view"
    },
    {
      "overlay": "modal <dialog> (showModal, top layer)",
      "openError": null,
      "pixelsInHostPageCapture": 53032,
      "pixelsWithViewShown": 0,
      "pixelsWithViewHidden": 53032,
      "result": "renders UNDER the view"
    },
    {
      "overlay": "position:fixed toast",
      "openError": null,
      "pixelsInHostPageCapture": 16875,
      "pixelsWithViewShown": 0,
      "pixelsWithViewHidden": 16875,
      "result": "renders UNDER the view"
    },
    {
      "overlay": "<select> picker (showPicker; a separate popup widget)",
      "openError": null,
      "pixelsInHostPageCapture": 51579,
      "pixelsWithViewShown": 51579,
      "pixelsWithViewHidden": 51579,
      "result": "renders over the view"
    }
  ],
  "underneath": [
    "modal <dialog> (showModal, top layer)",
    "position:fixed toast"
  ],
  "designRule": "the panel hides the view (setVisible(false)) whenever a renderer dialog, menu or toast may overlap it"
}

Summary: 1=GO 2=GO 3=GO 4=GO 5=GO 6=GO 7=GO 8=GO; Electron exit 0; missing items: none
```
