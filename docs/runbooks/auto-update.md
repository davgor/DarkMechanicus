# Auto-update and releases

Packaged Windows builds use **electron-updater** with GitHub Releases as the update server.

CI builds with `electron-builder --publish never` (artifacts only). The deploy workflow uploads release **files** only (`latest.yml`, installers, blockmaps, `.dmg`) via `gh release create`; unpacked build folders are not uploaded.

`npm run package:win` and `npm run package:mac` first run `scripts/packaging-guard.mjs`, which fails when the checkout's `node_modules` is a symbolic link or a Windows junction (as in a worktree that borrows another checkout's dependencies): electron-builder leaves the hoisted dependencies out of `app.asar` through such a link, and the packaged app does not start. Package from a checkout with its own `node_modules` folder (`npm ci` there).

## Local Windows EPERM during verification

A local Windows test or coverage run can fail with `EPERM` during an atomic fixture rename. In DM-918 this occurred in the `forgeService.test.ts` force-retirement scenario while replacing `forge-world.json` from a UUID-named temporary file. The error alone does not establish antivirus interference, overlapping execution, or a harmless environment issue.

Before deployment:

1. Preserve the failed local command, full error/stack and source/destination paths, log location, tested commit SHA, and ticket/attempt identifier. Keep that local check **failed**; a CI pass never retroactively passes it.
2. Review the failure evidence independently for source/test defects. Do not dismiss a reproducible defect as environmental. Record confirmed findings separately from hypotheses; a passing run does not establish the historical cause.
3. Require independent, first-attempt verification on clean Windows CI runners for the **exact proposed revision**: all Windows test shards behind the `test` aggregate in [CI Checks](../../.github/workflows/pr-checks.yml) must pass, along with the remaining gates. Coverage thresholds are checked locally with `npm run coverage`, not by the GitHub workflow. An earlier revision's green run is not verification of a later change.
4. Record the CI run/job URLs, run attempt number, tested SHA, and test results alongside the local test and coverage evidence, keeping **local** and **CI** statuses separate. Review those records before deployment; missing or failed exact-revision CI leaves verification incomplete.

This procedure is not permission to rerun failing tests or CI until green, add retries, raise timeouts, skip tests, or conceal a reproducible source/test defect. Investigate and fix demonstrated defects with new evidence rather than treating every `EPERM` as harmless.

## Installers vs portable

| Artifact | Auto-update | GitHub Release |
|----------|-------------|----------------|
| `DarkMechanicus-Setup-x.y.z.exe` (NSIS) | Yes — background poll/download + **silent** install on quit or “Restart now” | Yes |
| `DarkMechanicus-x.y.z-Portable.exe` | No — manual download only | Yes |
| `DarkMechanicus-x.y.z-*.dmg` (macOS) | Manual for now (same release channel) | Yes |

Install the **Setup** build for automatic updates on Windows. Keep the portable build for users who want a single file without installing.

## First launch on macOS

macOS builds are **ad-hoc signed** (`mac.identity: "-"`, hardened runtime off) until Developer ID signing and notarization are set up. The deploy job runs `codesign --verify --deep --strict` on each packaged `.app` so a broken bundle signature (which Gatekeeper reports as "damaged … move to the Trash") cannot ship.

Ad-hoc apps are still not notarized, so the first launch of a downloaded build is blocked. Either:

- Try to open the app once, then **System Settings → Privacy & Security → Open Anyway**, or
- Clear the download quarantine after copying to Applications:

```bash
xattr -cr /Applications/DarkMechanicus.app
```

## How checks run (Setup builds)

1. **Initial check** ~8 seconds after launch
2. **Polling** every **4 hours** while the app stays open (skips if a check or download is already in flight)
3. **Manual check** — Updates → “Check for updates” (same guarded path; no-op in dev / when `DISABLE_AUTO_UPDATE=1`)

When an update is ready, the banner offers **Restart now**. Apply uses `quitAndInstall(true, true)`: silent NSIS (`/S`) and relaunch. Users should not see the installer wizard on update — only a brief restart.

A ready update does not stop checks: the poll and the manual check still query the feed.

- **Nothing newer** — the ready update and **Restart now** stay as they are.
- **Newer version** — the banner switches to downloading it, then offers **Restart now** for the newer version.
- **Check fails before a newer version is found** (for example offline) — the ready update and **Restart now** stay; the error is only logged.
- **Newer download fails** — electron-updater has already discarded the earlier installer, so the state becomes `error`. The next manual check or poll downloads the newest version again.

## Versioning

Each successful deploy to `main` runs `scripts/bump-minor-version.mjs` before packaging:

- `0.0.1` → `0.1.0` → `0.2.0`
- Release tag: `v0.1.0` (semver, no commit SHA suffix)
- `latest.yml` in the release powers in-app update checks

Version-bump commits use `[skip ci]` so deploy does not loop.

## Verify an update landed

The header shows `vX.Y.Z` next to the product name. After installing a Setup build and receiving an update, confirm that label matches the new release tag.

## Local / dev

Auto-update is disabled when `app.isPackaged` is false. Set `DISABLE_AUTO_UPDATE=1` to disable in packaged builds. Dev still shows `package.json` version via `app.getVersion()`.
