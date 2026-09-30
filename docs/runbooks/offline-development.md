# Flight development

The dependencies are installed in this checkout, including Electron's macOS binary, Vite, TypeScript, Vitest, electron-builder, `@modelcontextprotocol/sdk`, `zod`, and `@xyflow/react` (React Flow).

## Start locally

```bash
cd /Users/davidgorden/src/DarkMechanicus
npm run dev
```

Keep this checkout and `node_modules` on the laptop. Do not run `npm ci` before starting offline: it removes the installed dependency tree. No login, API key, cloud service, external font, or database is needed to run this starter. Development builds do not automatically check for updates.

## Local checks

```bash
npm run lint
npm run typecheck
npm test
npm run deadcode
npm run build
```

These commands use installed tools. If you need to reinstall, `npm ci --offline` can use npm's cache, but preserve the existing installation as the reliable starting point. Electron also keeps its own download cache, normally under `~/Library/Caches/electron` on macOS.

## Where things live

- `src/core/`: the command layer (database, services, portable records, import/finalizer). Business rules live only here. See [`docs/architecture.md`](../architecture.md).
- `src/mcp/`: the headless stdio MCP server (`out/main/mcp.js` after `npm run build`).
- `src/main/desktop/`: folder registry, IPC bridge, MCP config snippet, navigation hardening.
- `src/renderer/src/`: the React UI (sidebar, onboarding, plan graph, ticket panel, checkpoint view).
- `src/shared/domain/`: contracts shared by every process (statuses, plan bundle, views, `CommandApi`).
- `skills/`: provider-neutral agent instructions, also served as MCP prompts.

Everything runs offline: SQLite is the built-in `node:sqlite` module (no native rebuild), fonts fall back to system faces, and the MCP server talks over stdio. `npm run smoke:mcp` exercises the built MCP server locally.

## Network-dependent work

New packages, hosted model calls, remote MCP connections, publishing, and release signing can still need internet access. Full Windows installers and both Mac DMG architectures may download additional packaging assets; use `npm run build` for flight development. No local model weights have been downloaded.
