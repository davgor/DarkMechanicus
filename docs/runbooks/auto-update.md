# Auto-update and releases

Packaged Windows builds use **electron-updater** with GitHub Releases as the update server.

CI builds with `electron-builder --publish never` (artifacts only). The deploy workflow uploads release **files** only (`latest.yml`, installers, blockmaps, `.dmg`) via `gh release create`; unpacked build folders are not uploaded.

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
2. **Polling** every **4 hours** while the app stays open (skips if a check/download is already in flight or an update is ready)
3. **Manual check** — Updates → “Check for updates” (same guarded path; no-op in dev / when `DISABLE_AUTO_UPDATE=1`)

When an update is ready, the banner offers **Restart now**. Apply uses `quitAndInstall(true, true)`: silent NSIS (`/S`) and relaunch. Users should not see the installer wizard on update — only a brief restart.

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
