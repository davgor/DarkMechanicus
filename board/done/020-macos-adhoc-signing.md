# EPIC: macOS ad-hoc signing (stop "damaged" DMG installs)

Released macOS builds (v0.7.0) open as "DarkMechanicus is damaged and can't be opened. You should move it to the Trash." The DMG itself is intact (`hdiutil verify` passes); the `.app` inside carries only Electron's linker ad-hoc signature (`Identifier=Electron`, `Sealed Resources=none`) because the deploy job disables identity discovery and electron-builder skips signing. Browser quarantine plus an invalid bundle signature makes Gatekeeper report the app as damaged, with no "Open Anyway" path.

Interim fix until Developer ID signing + notarization: ad-hoc sign the whole bundle (`mac.identity: "-"`) with hardened runtime off (ad-hoc + hardened runtime fails library validation at launch), and verify the packaged signature in CI so a broken bundle cannot ship again.

## Acceptance criteria

- [x] `package.json` `build.mac` sets `identity: "-"` and `hardenedRuntime: false` (asserted by `scripts/mac-packaging.test.mjs`)
- [x] Deploy `package-mac` job runs `codesign --verify --deep --strict` on every packaged `.app` before uploading (asserted by `scripts/deploy-workflow.test.mjs`)
- [x] Local `npm run package:mac` produces arm64 + x64 apps that pass `codesign --verify --deep --strict` and launch
- [x] README / auto-update runbook document the unsigned-macOS first-launch step

Verification: new tests failed first (3 red), then passed. Full suite passes (3,332 app + 105 Fireguard). Lint, typecheck, deadcode and build are clean. Fireguard skipped because its `include` covers only `src/**/*.test.{ts,tsx}`, so `scripts/*.test.mjs` is out of scope. Local `npm run package:mac` signed both apps with `identityName=-` and gave no hardened-runtime warning. The CI verify loop passes on `release/mac-arm64` and `release/mac`, and on the app inside the arm64 DMG (`Identifier=com.davgor.darkmechanicus`, sealed resources). The shipped v0.7.0 app fails the same check ("code has no resources but signature indicates they must be present"). The packaged arm64 app launched and stayed up with its helper processes, and no signature or library-validation errors.

Still to check after the next release: download the DMG in a browser (quarantined) and confirm Gatekeeper shows the "Open Anyway" path instead of "damaged". Developer ID signing + notarization remains the real fix.
