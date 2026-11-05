# Sprint 3 acceptance (DM-442)

Built from branch omp-s3 (all four sprint 3 tickets merged): `npm run build`, then `npx electron-builder --win --dir`
(release/win-unpacked/). Every launch is the PACKAGED DarkMechanicus.exe with a throwaway `--user-data-dir`,
`DISABLE_AUTO_UPDATE=1`, scratch `DARKMECHANICUS_HOME`. Driven over CDP (`Page.captureScreenshot`, so only the app
window); main-process dialogs stubbed through `--inspect` (folder pick, omp.exe pick). OMP 18.16.0 (installed omp.exe).
c2-c4 use a scratch `PI_CODING_AGENT_DIR` (copy of the sprint 2 scratch agent: mock model via models.yml, dummy key) and a
local mock OpenAI-style server on 127.0.0.1:18405. Helper scripts used are alongside (launch/quit/cap/stub/click/t2.mjs).
The packaged `release/` output was copied twice (buildA, buildB): **the same code twice, not two different versions.**

## c1 (DM-438): met
- Launch with `PI_CODING_AGENT_DIR` unset (the person's real OMP sign-in, status read only; no chat opened, no login/logout).
  Agent was added with Add an agent -> Find (stubbed picker -> real omp.exe).
- `t2.mjs` relaunched the app (agent persisted in the throwaway profile) and polled the card: page up at 272 ms, card
  "Checking sign-in..." at 409 ms, **"Signed in" at 595 ms after launch** (status timeout is 10 s).
- `c1-01-skitarii-card-signed-in.png`: sidebar shows "Skitarii, v18.16.0, green dot, Signed in"; the Add an agent pane shows the
  Skitarii card "Connected - v18.16.0" and "Signed in".
- docs/reports/omp-cli.md section 5 holds the DM-438 signed-in recording (5 runs, 772/177/180/183/180 ms); its
  accountId/email/orgId/orgName are all `<redacted>`; no other identifiers (only endpoint URL, window/usage numbers).
- ~/.omp/agent before/after (`omp-before-*`, `omp-after-*`): config.yml sha256 unchanged
  (86d37ec2...d4450); settings.json unchanged; file listing identical except mtimes of the directory and `agent.db`.
  **agent.db hash changed** (a9f0665d... -> e62e5fe5..., size same 303104): the omp status probe (`omp usage --json`)
  caches usage into agent.db, i.e. omp's own side effect of the read; I did not write it myself and did not open a chat.
  (Its mtime was already 12:41 before my first launch, i.e. the person's own omp use touches it too.)

## c2 (DM-443): met
- `c2-01-skitarii-header-title.png`: new Skitarii chat in folder repo2; heading "New chat", beneath it muted text
  **"Skitarii - repo2"** (middle dot), then Terminal RUNNING, Orchestrator, "Allowed to save plans"; the Skitarii TUI banner is
  below. A stray "Stop tracking folder" menu from an earlier click is open in the sidebar (cosmetic, mine).

## c3 (DM-444): met
- Build A (`buildA`) initialized folder repo2 (Initialize folder in the UI); `.mcp.json` names `buildA\...` for command and mcp.js
  (`c3-mcp.json.1-initialized-by-buildA.txt`); I added by hand a server `other` (npx @acme/other-mcp, env key dummy) and a top-level `note`.
- Build A quit and its directory **deleted**. Plain `omp` in repo2 (pty capture, `c3-2-before-buildB-*.screen.txt`): "MCP servers failed to
  connect: darkmechanicus ... ENOENT ... uv_spawn", `/mcp list`: darkmechanicus not connected.
- Build B started with the same user-data-dir (so repo2 is tracked), nothing clicked, quit. `.mcp.json` diff
  (`c3-mcp.json.2-after-buildB-start.txt`): only the two paths changed, buildA -> buildB; `other`, `note`, role, `--allow-save`, label, env kept.
  (A first try with a fresh profile did not refresh because the folder was not tracked there; refresh is for tracked folders.)
- Plain `omp` in repo2 again (`c3-4-after-buildB-*.screen.txt`): `/mcp list` -> **darkmechanicus ● connected**, other not connected (it is a fake
  package and fails by design; its entry survived). Startup banner: "MCP finished with failures. Connected: darkmechanicus. Failed: other".
- Captures are node-pty + @xterm/headless screen text (not a screenshot).

## c4 (DM-445): met
- `c4-01-new-chat-banner-at-start.png`: new chat, Skitarii mascot banner (same shot as c2, taken before the prompt).
- `c4-02-history-before-quit.png`: after the prompt "hello skitarii" the mock reply "Mock turn 1: ... cog40 Done." is shown, banner gone.
- App quit (CDP Browser.close, no leftover processes) and relaunched with the same profile; the chat reopened by itself selected
  (RUNNING). `c4-03-reopened-chat-history-no-banner.png`: "hello skitarii" and the mock reply are shown, no banner. (No manual click was needed to reopen.)
- Note: the sidebar MCP line read "2 agent sessions" after the relaunch (vs 1 before); not part of the criteria, not investigated.

## Not done / limits
- Windows only. Two copies of one build as A/B. No real NSIS install/update.
