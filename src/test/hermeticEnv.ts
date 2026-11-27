/**
 * Vitest setup file: no test inherits a live desktop session. A shell the desktop app launched (an agent's or an
 * orchestrator's) exports the naming pipe and a grant; a test reaching them acts on the person's running app, as
 * src/mcp/tools/chatNaming.test.ts once renamed a real chat. A test that needs either sets it itself, through
 * `vi.stubEnv` or an explicit `env` option. Not shipped.
 */
delete process.env.DM_DESKTOP_PIPE
delete process.env.DM_BROWSER_PIPE
delete process.env.DM_SESSION_TOKEN
