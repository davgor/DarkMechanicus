# EPIC: Desktop and MCP hardening follow-ups

Defense-in-depth items raised while building epics 010–013; none is required by the current threat model (server-side authorization already rejects every disallowed call).

## Acceptance criteria

- [ ] IPC handlers verify the sender frame is the app's own page before running a command (tested, without breaking dev-server loading)
- [ ] The MCP server lists only the tools a session's role can call (tested)
- [ ] MCP input-validation failures return the structured `{ ok: false, error: { code: 'invalid_input' } }` payload instead of the SDK's plain-text error (tested)
