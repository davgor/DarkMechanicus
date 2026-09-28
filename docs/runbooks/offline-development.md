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

## Starting points

- `src/renderer/src/App.tsx`: visible ticket, agent graph, and MCP placeholders; these are static sketches, not working features.
- `src/main/tickets/`: ticket service notes; persistence and CRUD are still to be built.
- `src/main/mcp/`: MCP boundary and proposed first tools; no server is started yet.
- `src/preload/index.ts`: existing narrow Electron bridge; extend this when adding desktop ticket operations.
- `src/shared/`: future ticket and graph contracts shared across processes.
- Graph UI: import components from `@xyflow/react` and its stylesheet from `@xyflow/react/dist/style.css` when implementing the canvas. The package is downloaded but not yet mounted in the UI.
- SDK documentation and TypeScript declarations are available locally in the packages under `node_modules`.

The project uses system Node for development tooling and Electron's bundled runtime for the app. Preparation used Node 24.8.0 and npm 11.6.0 on Apple Silicon.

Verified on 2026-09-28: Electron 42.9.0 launched, the production renderer displayed all three placeholder cards and returned the app version through preload IPC with HTTP/HTTPS blocked, all 79 tests passed, and lint/typecheck/deadcode/build passed. Compatible dependency audit fixes were applied with zero remaining findings.

## Network-dependent work

New packages, hosted model calls, remote MCP connections, publishing, and release signing can still need internet access. Full Windows installers and both Mac DMG architectures may download additional packaging assets; use `npm run build` for flight development. No local model weights have been downloaded.
