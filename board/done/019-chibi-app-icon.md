# EPIC: Chibi Mechanicus app icon

Give the desktop application a cute, red-hooded Mechanicus mascot, with platform icon exports and a matching renderer favicon.

## Acceptance criteria

- [x] Transparent master illustration and PNG, ICO, ICNS exports saved in the repository.
- [x] Windows and macOS packaging explicitly reference the new icons; the renderer uses a matching favicon.
- [x] Icon formats and built favicon verified; lint, tests, typecheck, deadcode and build pass.

Verification: lint, typecheck, deadcode and production build passed. All 3,431 tests passed (3,326 app + 105 Fireguard). Native Electron loaded the 1024px PNG and accepted Dock/window icon configuration. ICO contains seven sizes; ICNS and PNG alpha verified. Built favicon matches source. Full installer builds were not run.
