# DM-445: no banner when a chat is reopened

## Signal used: OMP's own, not an app flag

Verified against OMP 18.16.0 (source tag v18.16.0 and the installed `omp.exe` 18.16.0).

- `SessionStartEvent` is `{ type: "session_start" }` (`packages/coding-agent/src/extensibility/shared-events.ts`): no reason field.
- The handler's `ctx` is an `ExtensionContext` with `sessionManager: ReadonlySessionManager`, which has `getEntries()`.
  OMP itself tells a session with history by `hasConversationalHistory(entries)` (a `message` entry with role user or assistant).
- Observed with `probe.ts` loaded by `-e` in a pty (`probe-session-start-entries.log`), scratch `PI_CODING_AGENT_DIR`:
  - new session: `n: 2`, types `model_change, thinking_level_change` (no messages)
  - same session after one prompt, started with `--continue`: `n: 7`, includes `message:user` and `message:assistant`
  So the entries are loaded before `session_start` fires, and a message among them reliably means "resumed". No launch-spec change, no env var, so no terminalLaunchSpec test.
- If `sessionManager` is missing or throws, the session counts as new (banner shows, as before).
- Edge: a resumed chat that never had a message (opened, no prompt, quit) still shows the banner, which is right: it has no history under it.

## c2 (dev app: built worktree run with electron, throwaway --user-data-dir, scratch PI_CODING_AGENT_DIR with a local mock model)

- `c2-01-new-chat-banner-at-start.png`: new chat, banner present.
- `c2-02-history-before-quit.png`: after one prompt (banner replaced by the turn, as before).
- `c2-03-reopened-chat-history-no-banner.png`: app quit and relaunched, same chat reopened: history ("hello skitarii" and the reply), no banner.
Screenshots are CDP page captures, so they show only the app window.
