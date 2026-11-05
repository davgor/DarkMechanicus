# DM-444: keep an initialized folder's `.mcp.json` working across builds

## Before: what the entry holds and why it breaks

`handlers.connectClaudeCode` -> `bootstrap.ts` `writeMcpServer(repo, claudeCodeServer(mcpConfigFor(repo), ...))`.
`mcpConfigFor` calls `buildMcpConfig` (`mcpConfig.ts`) with `app.isPackaged`, `process.execPath`, `app.getAppPath()`.

| build     | `command`                       | `args[0]`                                       | `env`                                               |
|-----------|---------------------------------|-------------------------------------------------|-----------------------------------------------------|
| dev       | `node` (PATH lookup)            | `<project>/out/main/mcp.js`                     | `DARKMECHANICUS_HOME`                               |
| packaged  | `process.execPath` (the app exe)| `<install>/resources/app.asar/out/main/mcp.js`  | `ELECTRON_RUN_AS_NODE=1`, `DARKMECHANICUS_HOME`     |

followed by `--repo <folder> --role <r> [--allow-save] --label "Claude Code"`. Both the script and (packaged)
the command are absolute paths into one build. Windows is `C:\...\DarkMechanicus.exe` / `...\resources\app.asar\...`,
macOS is `/Applications/DarkMechanicus.app/Contents/MacOS/DarkMechanicus` /
`.../Contents/Resources/app.asar/out/main/mcp.js`. When that build is updated away or deleted, the paths are
dead and omp/claude spawn fails with ENOENT. Captured: `omp-3-before-refresh.screen.txt`
("darkmechanicus: ENOENT: no such file or directory, uv_spawn ...", "not connected").

## Choice: (b) refresh on app start, only when the recorded build is gone

On start (`bootstrap.ts` `refreshClaudeCodeEntries`) each tracked, available, repo-mode folder is passed to
`refreshMcpServer` -> `refreshStaleServer` (pure, `mcpJson.ts`).

Why not (a), a stable launcher under userData the app rewrites on start:
- The launcher is itself a path the running build rewrites. Two builds installed side by side (dev + packaged,
  or two installs) would each rewrite it to themselves on every start: a ping-pong, with whichever started last
  winning and breaking the other. (b) never touches an entry whose build still exists.
- It needs a launcher file per OS (a `.cmd` on Windows, an executable shell script on macOS), exec bits and quoting
  rules, and a new moving part that can itself go stale or be blocked by AV / Gatekeeper.
- It changes every initialized `.mcp.json` shape (entries written by older builds would still need (b) to migrate).
(a) would also keep working with the app closed and unrun after an update; (b) only repairs on the next app start.
That is the accepted trade-off: the app is what the person updates and launches, and the broken window is just
"after the old build vanished, before the new one first started".

Rules in `refreshStaleServer`:
- **Ownership:** the `darkmechanicus` entry must be an object with string args, `args[0]` named `mcp.js`,
  `--repo` equal to this folder (case and slash insensitive for Windows drive paths) and `--label "Claude Code"`.
  Anything else (hand-written, snippet copied from the app without a label, a different folder, no entry, invalid
  JSON, not an object) is left alone. `refreshMcpServer` keeps the existing file checks: only a regular file (not a
  link) whose real path is inside the repo; every error is swallowed and means "no change".
- **Stale only:** rewritten only if `args[0]` or an absolute `command` no longer exists. If it still exists (other
  build installed), nothing is written, from either build. No ping-pong.
- **Never write a broken path:** skipped when the running build's own `mcp.js` is missing (e.g. an unbuilt dev tree).
- **Minimal edit:** only `command`, `args[0]` and `ELECTRON_RUN_AS_NODE` change (so packaged <-> dev moves work);
  role, `--allow-save`, label, other args, the person's own env variables, other servers and other top-level keys are
  kept, in place. `DARKMECHANICUS_HOME` is only added if missing.
- `existsSync` is injected (`exists`), so the logic is I/O-free and tested for POSIX and Windows paths.

## Tests
`mcpJson.test.ts` (`refreshStaleServer`), `mcpJsonFile.test.ts` (`refreshMcpServer` on a real temp repo with real
"build" dirs, deleting the initializing one). Without the production change they fail (module has no such export):
`tests-without-change.txt` (15 failed).

## c2 evidence (built app, scratch everything)
Scratch dir `scratchpad\c444` (not in the repo): temp git repo, `--user-data-dir` throwaway, `DARKMECHANICUS_HOME`
and `PI_CODING_AGENT_DIR` scratch. `npm run build` + `electron-builder --win --dir` once; the unpacked output was
copied to `buildA` and `buildB` (**the same code twice, not two different versions**; this simulates "the build that
initialized the folder was removed"). Driver: `drive.mjs` (CDP).

1. `buildA` started, `window.dm.connectClaudeCode(repo, {role:'planner'})` -> `created`.
   Then I added `other` and a `note` key by hand. `mcp.json.1-initialized-by-buildA.txt` names `buildA\...`.
2. `buildA` stopped and **deleted**. Plain `omp` in the repo: `omp-3-before-refresh.screen.txt`:
   darkmechanicus ENOENT, "not connected".
3. `buildB` started (nothing clicked) and stopped. `mcp.json.2-after-buildB-start.txt`: diff is only the two
   paths (`buildA` -> `buildB`); `other`, `note`, role, label, env kept.
4. Plain `omp` in the repo again, `/mcp list`: `omp-4-after-refresh.screen.txt`:
   "MCP finished with failures. Connected: darkmechanicus. Failed: other" and `darkmechanicus ● connected`.
   (`other` is a fake `npx @acme/other-mcp` package and fails by design; it proves the entry survived.)

Not done: macOS run (paths covered by unit tests only); a real second version of the app; the real NSIS install/update.
