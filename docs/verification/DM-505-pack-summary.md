# DM-505 c8 packaging evidence (base 966459a, `skitarii-s1-integration`)

Environment: Windows 10.0.26200 x64, Node v24.22.3, Electron 42.11.18, app 0.34.0, OMP `omp/18.20.2`
(`%LOCALAPPDATA%\omp\omp.exe`). Only OMP's auth was copied (`omp auth export | omp auth import -`) into each run's scratch
`.omp/agent`; every scratch root (profile, home, DM home, repo) was deleted at the end. No model prompt was sent.

## Artifacts (`npm run package:win`, exit 0, log `DM-505-pack-package-win.log`)

| Artifact | SHA-256 |
| --- | --- |
| `release/DarkMechanicus-0.34.0-Portable.exe` | b10f13ed701be7442863278fb989e6a97b5c51f90576f53fde5af40179dfb0c7 |
| `release/DarkMechanicus-Setup-0.34.0.exe` (real installer, NOT run) | 3016736b4e877788c500c5fc9716b0a8c30be71af3d5531348cd0cc60e7b9b8e |
| `release-acc/DM Acceptance-Setup-0.34.0.exe` (scratch variant) | 722e1e27db3a075874e998b92ac146689c94f79c56509cdf30a76dbd5603d873 |

The scratch variant: `npx electron-builder --win nsis --x64 --publish never -c.appId=com.davgor.darkmechanicus.acceptance
"-c.productName=DM Acceptance" -c.directories.output=release-acc` from the same `out/` (log
`DM-505-pack-acceptance-nsis-build.log`). Installed with `/S /D=%TEMP%\dm505-installed` (exit 0), verified, uninstalled
with `Uninstall DM Acceptance.exe /S` (exit 0): folder gone, no "DM Acceptance" HKCU uninstall key left.

## Runs (`DM-505-pack-smoke.mjs`, one fresh run each; results `DM-505-pack-<label>-result.json`, logs `.log`)

Each run, for the dev build (`node_modules/electron` + project), the portable exe and the installed scratch exe:
renderer loaded; two OMP chats (Alpha, Beta) started in the native PTY with mailboxes; OMP launched with
`-e <resources>\skitarii\extension\index.ts`; `index.ts`, `dmClient.ts`, `messaging.ts` exist there, identical to the
repo, and `app.asar` holds `out/main/cli.js` but no extension file; each launch's `dm-client/<generation>.json` pins the
build's own exe and `<resources>\app.asar\out\main\cli.js` (dev: project Electron + `out\main\cli.js`) with no grant; a
fixture message Alpha→Beta was put in the store and Beta's extension painted `Skitarii mail: 1 unread` and the notice
"1 new message from Alpha" — which needs its dmClient to run the packaged CLI child with Beta's bound grant; the process
list caught those children (`<exe> <resources>\app.asar\out\main\cli.js --repo <repo> call get_agent_mail_status -`,
parent omp.exe). Closing the window ended every owned process within 10 s.

Portable run 1 (`DM-505-pack-portable-run1*`) had every check pass but failed `processes-gone-after-quit`: the
harness killed the portable stub process, which does not end the extracted app. Harness defect, not the app's; the
driver now quits by closing the window and run 2 passed. Dev run 1 failed before launch (harness passed a bad Electron
path); its rerun is the recorded one.

## Real install untouched

`DM-505-pack-real-install-before.txt` and `-after.txt` (sha256, mtime, size of
`%LOCALAPPDATA%\Programs\dark-mechanicus\DarkMechanicus.exe`) are byte-identical.

Screenshots: `DM-505-pack-{dev,portable,installed}-beta-terminal.png`.
