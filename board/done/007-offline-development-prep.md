# 007 — Offline development preparation

Prepare this Mac for flight development, with the Electron toolchain downloaded and lightweight starting points for a custom ticket system, agent graph, and MCP layer.

## Acceptance criteria

- [x] Electron's local binary launches and the desktop shell renders.
- [x] MCP SDK, Zod, and React Flow are installed and locked for local development.
- [x] Shell includes clearly labeled ticket, graph, and MCP placeholders.
- [x] Offline startup and module starting points are documented.
- [x] Lint, tests, typecheck, deadcode, and production build pass.

## Verification — 2026-09-28

Installed Electron 42.9.0 (macOS arm64), MCP SDK 1.31.0, Zod 4.6.5, and React Flow 12.12.0. Applied compatible npm audit fixes; zero findings remain. All 79 existing tests pass, along with lint, typecheck, deadcode, and build. No unit tests were added or changed; changes are dependency preparation, static UI, and documentation.

Launched `npm run dev` successfully. A temporary Electron integration smoke check against the production build loaded all three placeholder cards and exercised the real preload version IPC with HTTP/HTTPS requests blocked. Visual screenshot inspection was unavailable because Computer Use permissions were pending. No installer, publishing, or model download was required.
