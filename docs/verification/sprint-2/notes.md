# Sprint 2 acceptance (DM-405)

The first attempt found that the packaged app crashed at startup (see "Blocker (fixed)" below). The
orchestrator fixed it in e30ed2b and merged the fix into dm-405 (5adfca7). After that I reran `npm ci`,
`npm run build` and `npx electron-builder --win --dir`, and gathered the evidence below with
`release/win-unpacked/DarkMechanicus.exe`.

## How it was run

- **Launch:** `DarkMechanicus.exe --user-data-dir=<scratch>\ud --remote-debugging-port=9350 --inspect=9351`.
- **Environment:** `DISABLE_AUTO_UPDATE=1`, `DARKMECHANICUS_HOME=<scratch>\dmhome`,
  `PI_CODING_AGENT_DIR=<scratch>\agent`. `ELECTRON_RUN_AS_NODE` was unset.
- **Driving:** the renderer over CDP.
- **Stubbed dialogs:** native dialogs were stubbed through the main-process inspector. That covers the
  folder pick and the omp.exe / node.exe pick (`dialog.showOpenDialog`), and the Custom CLI "Run and save"
  confirmation (`dialog.showMessageBox`, answered "Run and save").
- **Mock turns:** a local OpenAI-compatible SSE server on 127.0.0.1:18405 streams one word every 250 ms.
  - The scratch agent dir's `models.yml` defines provider `mock` with model `mock-1`.
  - `config.yml` sets `modelRoles.default: mock/mock-1`.
  - I later added `setupVersion: 2`, so that plain `omp` in Windows Terminal skips its first-run wizard.
  - A dummy anthropic key was added with `omp auth import`.
- **OMP:** the person's installed omp.exe 18.16.0 (`%LOCALAPPDATA%\omp\omp.exe`), found with Add agent → Find.
- **Screenshots:** app shots are CDP `Page.captureScreenshot`, so they show only the app's own window.
  Windows Terminal shots are `PrintWindow` of that one WT window.

## Per criterion

- **c1: met.**
  - `c1-01-skitarii-tui-banner-in-app.png` shows a new Skitarii chat in the packaged app beside the app's
    sidebar and header. In the TUI:
    - gunmetal background
    - crimson: the hooded mascot, the prompt cursor and the context % gauge
    - brass: the "The Omnissiah guides this forge" line and the path/branch status segments
    - bone: the "S K I T A R I I" heading
    - lens-green: the mascot's lens, and the branch segment when the tree is clean (`c3-01-...`)
  - No green success line from a tool appears in these shots. The `!` command in c9 ran successfully, but
    its output is plain JSON.
  - The person's real `~/.omp/agent/config.yml`:
    - Before (03:41): sha256 `86d37ec2acda1e86d5618526fae57cd626d05596dbc1a673436f0fd92e4d3450`, 60 bytes,
      mtime 2026-11-02 20:50:04. No `theme` line (only `shellPath` and `setupVersion`), and no
      `~/.omp/agent/themes/`.
    - After (04:12): the same hash, size and mtime. Still no theme line, still no `themes/`.
  - Under the scratch agent dir the app wrote only `themes/skitarii.json` (2691 bytes). The rest is OMP's own
    state (dbs, `sessions/`, `cache/`, `predict/`, `custom-session-files/`) plus my `models.yml` and
    `config.yml`.
- **c2: met.** `c2-01-mascot-frames-in-packaged-pane.png`.
  - A Custom CLI agent "Frame printer" runs `node printframes.mjs <release>/resources/skitarii/mascot/frames.json`,
    reading the packaged copy, in the packaged app's pane.
  - It shows the red-hooded tech-priest in idle "settled" and "hand-fidget" (16x27) and in drill
    "raise-drill" and "enthusiastic-recoil" (16x31).
- **c3: met. The title was captured from the PTY, not shown on screen.**
  - **New Skitarii chat at start:** `c3-01`/`c3-02` show the mascot banner with SKITARII and a Mechanicus
    line. The banner animates through idle frames; the two shots show different frames.
  - **While working:** `c3-03`/`c3-04` show the drill indicator under the loader and the Mechanicus status
    "Communing with the machine spirit", with the shimmer on "Commun".
  - **After the turn:** `c3-05`, the indicator is gone.
  - **Title:** `c3-06-pty-osc-titles.json`. The app does not display OSC titles, so the title was recorded
    in main by wrapping `MessagePortMain.prototype.postMessage` and scanning the terminal `output` messages
    for OSC 0/2.
    - Each new chat emits OMP's own `π >` and `π > repo`, then the extension's `Skitarii · repo` about
      250 ms later.
    - So the last title set is Skitarii's.
  - **Plain `omp` in Windows Terminal:** `c3-07` (start) and `c3-08` (working). Same scratch agent dir and
    repo, no app overlay or extension.
    - Stock OMP logo and tip, default (blue/teal) theme, no mascot banner, plain "Working…" with no drill or
      Mechanicus text.
    - The WT tab title there is my `--title omp-plain-s2acc`; title changes from the app were suppressed, so
      that shot says nothing about the title.
    - The "MCP server failed to connect: darkmechanicus" line comes from the repo's `.mcp.json`, which the
      sprint 1 build wrote pointing at its now-removed scratch tree. It is unrelated to this check.
- **c4: met, with one substitution: the folder Default agent selector stands in for a New chat picker.**
  - **Add agent:** `c4-01` shows the "Skitarii" card ("Skitarii, the Mechanicus-styled coding agent built on
    OMP (oh-my-pi)").
  - **Agent card:** `c4-02` shows "AGENT / Skitarii … Skitarii reports it is signed in". The sidebar lists
    "Skitarii".
  - **Chat header:** "SKITARII" eyebrow in `c4-04`, `c3-*` and `c5-*`. The sidebar rows read "Skitarii ·
    Default model".
  - **New chat picker:** in this build, New chat opens the folder's default agent with one click and shows
    no picker. The agent choice is the folder's Default agent selector, which reads "None / Skitarii / Frame
    printer". `c4-03` shows it set to Skitarii.
    - The Start run dialog's agent choice was not shown: it needs an epic, and this scratch folder has none.
  - **Sprint 1 chat:**
    1. Built the sprint 1 tree (`git worktree add <scratch> 261f966`, `npm ci`, `npm run build`) and ran it
       on the same user-data dir.
    2. Found OMP, initialized the folder, and made an OMP Orchestrator chat with one mock turn
       (`c4-00-...png`): "sprint one turn: remember the word BRASSCOG".
    3. Quit, and removed the scratch worktree.
    4. Opened the same user-data dir in the sprint 2 packaged build. The agent lists as "Skitarii", the chat
       row reads "Skitarii · Default model", and the chat reopened with its earlier exchange
       (`c4-04-...png`).
    5. A new turn continued the same session (`c4-05-...png`). The chat's one session file
       `agents/omp/chat_373779b1-.../sessions/2026-11-05T09-44-29-365Z_....jsonl` grew from 8 to 11 lines,
       and no new session file appeared.
  - The branch `omp-terminal` was not touched.
- **c5: met.**
  - `c5-01-header-drilling-while-streaming.png` shows the header mascot in the drill pose while the mock
    reply streams. `c5-02-header-idle-after.png` shows the idle pose after the turn ends.
  - `c5-03`/`c5-04` are 3x crops of the header mascot from those two shots.
  - The terminal sits under the brass rule, on the gunmetal header.
- **c6: met.** See `c6-package-listing.txt`, re-listed after the rebuild: same layout.
  - `THIRD_PARTY_NOTICES.md` is at the root of `release/win-unpacked/resources/app.asar`, not a loose file.
  - The extracted file is byte-identical to the repository's and holds the oh-my-pi MIT license with all
    three copyright lines.
- **c7: not met.** The person is not signed in, and DM-438 is deferred. Not attempted.
- **c8: met.**
  - `c8-01` before: `agents/omp/` holds chat_373779b1, chat_83901a63, chat_968ad502 and chat_e91eda30.
  - Deleted the newest Skitarii chat from its row menu (Delete → `c8-02` confirm → Delete chat).
  - `c8-03` after: chat_968ad502 is gone, and the other three are untouched.
- **c9: met.**
  1. In an OMP Orchestrator chat (chat_e91eda30, header "Orchestrator"), typed `!` plus the line from the
     chat's instructions file (`agents/instructions/<chat>.md`, line 11):
     `'…\release\win-unpacked\DarkMechanicus.exe' '…\resources\app.asar\out\main\cli.js' --repo '…\repo' call get_capabilities '{}'`
  2. It ran in OMP's `!` shell (`c9-01`) and printed `"ok": true` … `"role": "orchestrator"` (`c9-02`,
     scrolled up after Ctrl+O expanded the output).
  - This is the packaged exe line, which relies on the chat's `ELECTRON_RUN_AS_NODE=1`.

## Blocker (fixed)

`blocker-01-...png` and `blocker-02-...png` record the original crash:

- **Error:** `RangeError: Array buffer allocation failed` in `@xterm/addon-unicode-graphemes` 0.4.0, at
  packaged startup, in both sprint 2 and sprint 1 (261f966) builds.
- **Cause:** `new DataView(e.buffer)` on a pooled `Buffer` ignores its `byteOffset` (300 in a 65536-byte
  pool), so the length read 3221271680 instead of 51056.
- **Fix:** the orchestrator's postinstall patch `scripts/xtermGraphemesPatch.mjs`.
- **After the fix:** the packaged app starts (`fix-packaged-starts.png`, the orchestrator's) and ran all
  of the above.

## Definition of done (dm-405 after merging the fix, Windows, this machine)

- lint, typecheck, deadcode, build: passed.
- test and coverage: 17 failed, 9899 passed, 55 skipped (9971).
  - All 17 fail with `EPERM: operation not permitted, symlink`, in chatHandlers.folder, launchFolder,
    folderAgentDefaults, conflictsOpen, handlersWorkingDiff, operationLock and terminalHandlers.
  - This session cannot create symlinks, so the failures come from the environment only. CI on the PR is
    the judge.

## Cleanup

- `release/` deleted.
- The sprint 1 scratch worktree removed.
- The app quit, the mock server stopped, and the Windows Terminal window closed. No omp.exe left running.
