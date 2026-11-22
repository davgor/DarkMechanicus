# Historical portable records

These nine files are a frozen compatibility fixture extracted from commit
`af56ff445e8b8080cc3bd4e6e78d915cd78ceb8d`, under `.darkmechanicus/`.
They are test inputs, not this repository's active ticket store or current policy.
Tests must not retrieve the person's Forge World or restore a root ticket store.

- `project.json` and the three `profiles/` examples exercise the original portable
  formats, canonical serialization, and vendor-neutral capability descriptions.
- The completed MCP connection epic keeps its current revision, state, snapshot,
  and run record. The desktop integration test imports these into a disposable
  checkout and verifies the historical outcome/report before and after restart.
- Both snapshot JSON files retain their original bytes and stored content hashes.
  Their tickets predate the image-attachment field. Rebuilding these snapshots
  with today's serializer would hide backward-compatibility failures.

Only the records these assertions need are retained. Comments, unrelated epics,
attachments, and all machine-local state are excluded. No credentials or machine
configuration are needed to run the tests.
