# EPIC: Fireguard mutation scoping

Fireguard's mutation gate re-runs every graded test file for every mutant, which does not scale to milestone-sized changes. Run only the graded tests that (transitively) import the mutated module — the only tests that can kill its mutants — so grading semantics are unchanged but runtime drops.

## Acceptance criteria

- [ ] A static import graph (relative imports, `.ts/.tsx/.mjs/.js`, index files) maps each changed module to the graded tests that reach it (tested in `fireguard/test`)
- [ ] The mutation gate runs each module's mutants against only its related graded tests; modules with none still count as survivors (tested)
- [ ] `npm run test:fireguard` passes
