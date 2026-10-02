# EPIC: Chibi Mechanicus app icon

Give the desktop application a cute, red-hooded Mechanicus mascot, with platform icon exports and a matching renderer favicon.

## Acceptance criteria

- [x] Transparent master illustration and PNG, ICO, ICNS exports saved in the repository.
- [x] Windows and macOS packaging explicitly reference the new icons; the renderer uses a matching favicon.
- [x] Icon formats and built favicon verified; lint, tests, typecheck, deadcode and build pass.

Verification: lint, typecheck, deadcode and production build passed. All 3,431 tests passed (3,326 app + 105 Fireguard). Native Electron loaded the 1024px PNG and accepted Dock/window icon configuration. ICO contains seven sizes; ICNS and PNG alpha verified. Built favicon matches source. Full installer builds were not run.

CI follow-up: added `src/main/index.test.ts` to cover readiness, shared window/Dock icon selection, and startup without a Dock. Removing the icon wiring makes both regression tests fail. Lint, typecheck, deadcode, build and all 3,433 tests pass. Fireguard grades the working change A (96), with 100/100 isolated runs and no failures. Its built-in operators generate no mutants for this startup module, so removal of the wiring was checked separately. Initial local grading included the then-uncommitted test through the grading API; the test was committed concurrently as `032a6d3`.

Windows CI follow-up: replaced the hard-coded `renderer/index.html` assertion suffix with `join('renderer', 'index.html')`, matching native Windows backslashes and POSIX slashes. Verified the exact Windows path from the failure log, all 3,433 tests, lint, typecheck, deadcode and build locally. The standard Fireguard CLI against `origin/main` passes with A (96), 100/100 isolated runs and no failures. Windows CI still needs to rerun with this test correction.
