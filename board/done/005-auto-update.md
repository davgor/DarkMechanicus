# EPIC: Auto-update (electron-updater)

Wire electron-updater against GitHub Releases: main-process polling, preload IPC, renderer version label / check button / update banner, and runbook.

## Acceptance criteria

- [x] Main process schedules initial + recurring update checks when packaged (honors `DISABLE_AUTO_UPDATE=1`)
- [x] Preload exposes typed `autoUpdate` + `appInfo` APIs via contextBridge
- [x] Renderer shows version label, check-for-updates control, and restart banner when downloaded
- [x] Unit tests cover scheduling guards and silent `quitAndInstall(true, true)`
- [x] `docs/runbooks/auto-update.md` documents installer vs portable behavior
