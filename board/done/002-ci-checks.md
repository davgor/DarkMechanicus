# EPIC: CI Checks (GitHub Actions)

Mirror CapitalGains `pr-checks.yml`: unit tests, fireguard, lint, and typecheck+build on every PR and push to `main`, plus auto-revert on main CI failure.

## Acceptance criteria

- [x] `.github/workflows/pr-checks.yml` named **CI Checks** runs `test`, `fireguard`, `lint`, and `build` jobs
- [x] Push commits containing `[skip ci]` skip the push-triggered jobs
- [x] `.github/workflows/auto-revert.yml` reverts `main` when CI Checks fails (skips if HEAD is already a revert)
- [x] README documents treating `test`, `fireguard`, `lint`, and `build` as required status checks
