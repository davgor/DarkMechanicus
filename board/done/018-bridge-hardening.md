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

### Integration and gate

Merged into `claude/dazzling-sagan-03on5q` with epics 016–018 together (schema migrations v2–v4, one capability table for every command). Full gate on the merged head: lint and typecheck clean, `npm test` green, deadcode clean, build ok, `npm run smoke:mcp` passes (55 tools for an orchestrator with `--allow-save`). Checked in the real app under Xvfb with separate orchestrator and worker MCP processes: comments render and are added from the desktop, a profile applied in the ticket editor reaches the draft, the worker's tool list is filtered, bad arguments answer `invalid_input`, and the IPC guard refused nothing from the app page. Fireguard over the three epics (`cf63a23..6eac375`): **A (score 99)**, flake 100/100, mutation 97% (522 of 540; the survivors sit on pre-existing lines graded in the first run, plus one equivalent mutant).

### Review follow-ups

The independent review of the three epics found nothing to fix in the IPC guard or the MCP layer: every channel goes through the guard (subframes, `about:blank`, `blob:`, navigated pages and other file paths are refused), hidden tools answer `unauthorized` before validation, unknown tools answer `not_found`, and `__proto__` keys are dropped. Arguments that are not an object at all (`null`, an array, a string) still get the SDK's JSON-RPC InvalidParams error, as before.
