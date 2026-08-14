# EPIC: Release deploy (Win + Mac packages)

Mirror CapitalGains deployment: after **CI Checks** succeeds on `main`, bump minor version, package Windows (NSIS + portable) and macOS (`.dmg`), and publish a GitHub Release with top-level `release/` artifacts only (including `latest.yml` for auto-update).

## Acceptance criteria

- [x] `scripts/bump-minor-version.mjs` bumps `x.Y.Z` → `x.(Y+1).0` and syncs the lockfile
- [x] `package.json` defines `package:win` / `package:mac` with electron-builder targets under `release/`
- [x] `.github/workflows/deploy.yml` gates on CI Checks, skips `[skip ci]`, packages Win+Mac, creates a GitHub Release
- [x] Release job checks out the bump SHA and passes `--repo` to `gh release create`
- [x] README + `docs/runbooks/auto-update.md` document the release pipeline
