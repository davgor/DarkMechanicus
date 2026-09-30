# EPIC: Desktop and MCP hardening follow-ups

Defense-in-depth items raised while building epics 010–013; none is required by the current threat model (server-side authorization already rejects every disallowed call).

## Acceptance criteria

- [x] IPC handlers verify the sender frame is the app's own page before running a command (tested, without breaking dev-server loading)
- [x] The MCP server lists only the tools a session's role can call (tested)
- [x] MCP input-validation failures return the structured `{ ok: false, error: { code: 'invalid_input' } }` payload instead of the SDK's plain-text error (tested)

## Verification — 2026-09-30

- **IPC sender check:** `src/main/ipcGuard.test.ts` covers the predicate (packaged file URL, query and hash, resolved path versus prefix, another file, another host, foreign origin, dev origin, dev URL outside development, subframe, missing, destroyed, detached, and disposed frames), shows that an untrusted `dm:command` never opens or calls a workspace and that every `dm:*` channel is refused, and scans `src/main` so that only `index.ts` touches `ipcMain`, through `guardIpc`. Also `src/main/desktop/navigation.test.ts` (`isAppUrl`, file URL on another host) and `src/main/autoUpdate.test.ts` (channels registered on the guarded registrar). In the real app under Xvfb, the packaged `file://` page and the `electron-vite dev` renderer (`http://localhost:5173/`) both use the bridge, and a second window with the same preload on a `data:` page is refused on every channel.
- **Tools per role:** `src/core/commands/capabilities.test.ts` (every command, every role: refused exactly when the role lacks the declared capability), `src/mcp/roles.test.ts` (exact lists for planner and orchestrator with and without `--allow-save`, worker, reviewer; read-only tools for every role; withheld tools answer `unauthorized`), `src/mcp/tools/define.test.ts`, `src/mcp/main.test.ts`, `src/integration/mcp.test.ts`, and the built server over stdio.
- **invalid_input:** `src/mcp/validation.test.ts` (missing field, wrong type, unknown enum value, nested wrong type, extra nested field, several fields, omitted arguments, valid calls, advertised schemas pinned to their pre-change fingerprints), `src/mcp/result.test.ts`, `src/mcp/tools/define.test.ts`.
- **Gate:** `npm run lint`, `npm run typecheck`, `npm test` (3018 app and 105 fireguard tests), `npm run deadcode`, `npm run build`, and `npm run smoke:mcp` pass.
