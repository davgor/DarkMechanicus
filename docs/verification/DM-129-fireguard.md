# DM-129 Fireguard verification

- Graded commit: `f39080c7819fd7a9c6165c72857a3094283bb71b`
- Base commit: `3f0e33a6ec21ec19641ff2df4a2b3cbc2f9f2211`
- Command: `npm run fireguard -- --json`
- Test command override: `node node_modules/vitest/vitest.mjs run`
- Exit: 0; grade **A** (91)
- AST: 251 assertions, 0 mocks, 0 tautologies
- Flake: 100 of 100 runs passed
- Mutation: 238 killed, 72 survived, 310 total, 77% (minimum 75%)
- Full result: [DM-129-fireguard.json](DM-129-fireguard.json)

The report grades the test commit above. This summary and its full JSON were added afterward and do not change the graded tests or production modules.
