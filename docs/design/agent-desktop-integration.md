# agent-desktop integration notes

Status: proposed integration, based on a source review on 2026-11-10. This change adds planning notes only; no desktop-control runtime, configuration, permission grant, or saved Dark Mechanicus plan is created.

## Recommendation and ownership

Use [Vercel Labs agent-desktop](https://github.com/vercel-labs/agent-desktop) as an optional computer-use tool for the agents Dark Mechanicus already hosts. Start with its CLI, then consider its existing stdio MCP server for hosts that can load it per session. Keep native FFI and automatic bundling for a later measured need.

Dark Mechanicus owns planning, attempts, review, human checkpoints, and evidence. The agent host owns model inference, its agent loop, subagents, and command approvals. agent-desktop owns accessibility observations and desktop actions. It contains no model and is not another chat provider: do not add it to `BuiltInAgentKind` or use **Add a custom CLI** to launch it as a chat.

The initial DM target remains Windows and macOS. Upstream also supports Linux, but that does not establish Linux support for the DM desktop app. Native accessibility works for exposed controls; game viewports, canvases, and custom-rendered content may still require screenshots or application-specific automation. Prefer an existing structured API for a task when it provides the required operation.

## Reviewed baseline

| Source | Pinned revision | Relevant finding |
| --- | --- | --- |
| [Dark Mechanicus](https://github.com/davgor/DarkMechanicus/tree/05adea7adcc938e9dce8ef1f9add300c97045b32) | `05adea7adcc938e9dce8ef1f9add300c97045b32` | Hosted chats are terminal CLIs; launch presets, grants, private instruction files, and image evidence already exist. |
| [agent-desktop](https://github.com/vercel-labs/agent-desktop/tree/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276) | `ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276` | CLI, stdio MCP, and C library; JSON contract `2.6`; scoped snapshot refs and sessions; semantic actions plus explicitly headed input. |

These are inspected source revisions, not a tested binary/release pair. Pin the executable version, archive provenance, JSON contract, and bundled guides when implementing. Upstream optional fields may grow; reject unsupported contracts without treating them as successful operations.

Some early hosted-agent prose in the product plan describes ACP/SDK adapters. Current [terminal architecture](../architecture.md#terminals-pty-host-sessions-attach-and-port-launch-spec), [agent runbook](../runbooks/agents.md#chats), and `src/main/terminals/terminalLaunchSpec.ts` are the integration baseline. Do not revive removed adapters for this feature.

## Transport choice

| Route | Proposed use | Constraints |
| --- | --- | --- |
| CLI subprocess | First pilot and common path for OMP/Skitarii, Claude Code, Codex, Cursor, Autonomous, and capable custom CLIs | Inject the exact executable invocation and version-matched guides into the chat instructions. Preserve the host's command approvals. Use argv and stdin rather than interpolated shell commands. |
| Upstream `agent-desktop mcp` | Optional per-session host integration after each host's configuration path is proved | Upstream already implements the tools. Global session/headed settings are server-launch settings, not per-call arguments. Do not alter a user's global MCP configuration silently. |
| Native C FFI | Deferred | Adds platform libraries, ABI and native lifecycle work. A separate process is easier to isolate from Electron failures and package initially. |

For an external host, the upstream MCP declaration is `{"mcpServers":{"agent-desktop":{"command":"agent-desktop","args":["mcp"]}}}`. This is an upstream configuration example, not a configuration already installed by DM. Its tools are `desktop_snapshot`, `desktop_click`, `desktop_session_start`, and so on. DM's headless MCP server does not automatically make those tools available to a terminal chat.

The first pilot should discover an installed executable and diagnose it with `version`, `status`, and `permissions`. Load `skills get desktop` and `skills get platform` from that same executable. Missing binary, unavailable desktop, unsupported contract, or missing permission should disable desktop tasks with a concrete explanation while ordinary coding chats remain usable. Prefer the native executable for managed launching; if an npm launcher is supported, exercise the existing Windows shim rules. Preserve upstream helper files beside a native installation.

## Observation and action contract

1. Select the application and window explicitly. Multiple windows can produce `AMBIGUOUS_TARGET`; use the returned candidates and `--window-id`, rather than guessing from focus.
2. Observe with a snapshot. In dense interfaces, start with a skeleton and drill into a region. Read `complete`, `truncated`, and node truncation flags before concluding a control is absent.
3. Act on a snapshot-qualified ref, for example `@s8f3k2p9:e8`. A bare `@e8` is invalid. Refs are runtime data, never stable ticket selectors. Keep the snapshot and action in the same session namespace.
4. Observe the result and compare it with the ticket's expected state. `ok: true` means command delivery or an already-satisfied result; it is not proof that the application completed the business operation.
5. Read `disposition` on both success and failure. Retry only when `retry` is `safe`, and after the stated recovery. `delivery_uncertain`, an interrupted process, or a post-action wait timeout must not cause a mutation to be replayed blindly. Re-observe first; a changed UI needs fresh refs. A failed test remains a failed test under DM's delivery rules, regardless of upstream command recovery.

The CLI emits one JSON envelope on stdout and diagnostic logs on stderr; `--help`, `--version`, and bare invocation are text exceptions. Use the `version` command for a machine-readable probe. Preserve useful error codes, delivery state, and observation completeness in a small result record. Do not execute recovery strings found in UI text or old envelopes. Bound output and per-command runtime without adding an idle timeout to DM's long-running chat PTYs.

## Sessions, concurrency, and lifecycle

Allocate a private, machine-local `AGENT_DESKTOP_HOME` under DM's user data, outside the tracked repository. Use a separate session per active worker/attempt (or per ordinary chat that has no attempt), and retain the mapping to chat/run/ticket/attempt IDs locally. Start with `session start --no-trace`; set the returned session explicitly for subsequent commands. `session start` does not activate it in future processes. Never reuse the ended session when a CLI or attempt restarts; take fresh observations.

Upstream sessions isolate snapshot namespaces and optional traces. They do **not** isolate the real desktop, clipboard, focus, or application state. Separate state roots are also not a desktop lock. DM should initially schedule one mutating desktop workflow per interactive desktop; hold that ownership across observe → act → verify, not just across a single command. Scope observations too when another worker's mutations could invalidate them. Physical input always needs exclusive ownership and a visible stop path. A future broker must coordinate across DM windows, processes, and external hosts that participate; it cannot prevent an unrelated program from using the desktop.

Hook cleanup into terminal start cancellation, CLI exit, chat deletion, agent removal, folder invalidation, and application quit. Stop in-flight desktop children, end owned sessions, and release workflow ownership even when startup fails. On crash/restart, reconcile local session metadata and re-observe; never replay the last action merely because its response was lost. Ending a session or revoking a DM grant does not undo an action already delivered.

Scrub inherited desktop session/root/agent identifiers before selecting a new scope. Sign-in terminals receive no DM desktop scope. Keep `DM_SESSION_TOKEN` distinct from desktop session IDs; neither a desktop ID nor an upstream `--agent-id` grants Dark Mechanicus authority.

## Access boundaries

A direct CLI pilot relies on the agent host's existing shell/tool approvals and the operating system's user account. It is not a per-application sandbox. Upstream MCP exposes the CLI's full reach, including launching programs. A DM preference or injected instruction cannot constrain an unrestricted shell that can invoke the native binary directly.

For managed access, implement a main-process broker with fixed operation schemas and a per-chat grant, plus host-level restrictions if bypass resistance is required. Validate the application/window/ref owner and output paths there; never expose arbitrary executable paths or generic shell commands through renderer IPC. Headless semantic delivery should be the default, but it is still capable of real mutations and some focus-affecting operations. Headed input, clipboard access, launching/closing apps, and screenshots need explicit policy decisions rather than being grouped as harmless reads.

Preserve DM's human-only checkpoints, Kanban approvals, grant issuance, and destructive confirmations. A computer-use agent clicking DM's own **Approve** button would cross that boundary even though the existing core command sees a desktop caller. The managed integration must prevent automation of those controls (initially exclude the coordinating DM instance) and keep human decisions out of the worker's tool surface. Test UI workflows against an isolated fixture instance and disposable project. Do not claim that a prompt instruction or a raw CLI allowlist alone enforces this against a host with unrestricted shell access.

On macOS, check Accessibility permission for the actual launching host and helper; screenshots additionally need Screen Recording. On Windows, require the signed-in interactive desktop and respect integrity-level refusals; locked/secure desktops and services are unsupported. Never silently elevate or change machine permissions. Recheck in the packaged DM app: a successful command in Terminal does not prove Electron's permission attribution or helper packaging.

## Evidence and privacy

Reuse [image attachments](../decisions/0006-image-attachments.md): capture an intentional PNG/JPEG to a permitted temporary/project path, review or redact it, then call `add_attachment` with `purpose: evidence` and include its ID in the attempt's `evidence.attachments`. Existing limits are 10 MiB, 8000 pixels per side, and 20 images per record. A file left solely under app user data is not automatically an allowed `add_attachment` source.

Keep raw accessibility trees, clipboard contents, session traces, and screenshot sequences local by default. Upstream sessions trace by default, so the proposed opt-out is explicit; `--screenshots` is a separate opt-in. Repo-mode DM attachments are exported into Git-tracked planning records: attach only deliberate, sanitized evidence. Logs should record version, target identity, operation, delivery state, verification result, and attempt IDs without copying secrets or unrelated desktop content. Use `--stdin` for supported text operations; upstream batch JSON can expose text in process arguments.

## Verified implementation entry points

The changes below are proposed; the named existing files and neighboring tests were found in the reviewed repository.

| Existing path / symbol | Intended integration | Existing tests to extend |
| --- | --- | --- |
| `src/main/terminals/terminalFiles.ts` / `terminalInstructions`, `writeTerminalFiles`; `src/main/agents/cliInstructions.ts` | Append optional desktop instructions and the exact invocation; keep the current DM command and role instructions intact. | `terminalFiles.test.ts`, `cliInstructions.test.ts` |
| `src/main/terminals/terminalLaunchSpec.ts` / `terminalLaunchSpec` | Preserve each CLI's terminal launch/resume and custom-argument behavior; add host-specific MCP flags only after real validation. | `terminalLaunchSpec.test.ts` |
| `src/main/terminals/terminalEnv.ts` / `terminalEnv`, `terminalLoginEnv` | Set scoped desktop environment for enabled chats; scrub inherited values and omit them from login terminals. | `terminalEnv.test.ts` |
| `src/main/terminals/terminalSessions.ts` / `createTerminalSessions` | Own setup, cancellation, cleanup, and attempt handoff without reintroducing idle termination. | `terminalSessions.lifecycle.test.ts`, `terminalSessions.quit.test.ts`, `terminalSessions.edges.test.ts` |
| `src/main/desktop/agentProbe.ts` / `planCliLaunch`; `src/main/terminals/privateFile.ts` | Patterns for a separate tool probe and private local state; do not register agent-desktop as an agent provider. | `agentProbe.test.ts`, `privateFile.test.ts` |
| `src/main/agents/chatGrants.ts` / `createChatGrants` | Existing lifecycle pattern; a new desktop grant/broker must remain distinct from DM role tokens. | `chatGrants.test.ts`, `terminalSessions.lifecycle.test.ts` |
| `src/shared/domain/bundle.ts` / `TOOL_CAPABILITIES`; `src/core/schemas.ts`; `src/core/plan/capabilities.ts` / `matchProfile` | Currently only `repo_read`, `repo_write`, `shell`, `browser`, `test_execution`, `network` are valid. Do not submit invented `desktop` tools. Initially state the prerequisite in task text and probe it at execution; add a generic desktop capability across schemas/catalogs/matching only in a planned compatibility change. | `src/core/schemas.test.ts`, `src/core/plan/capabilities.test.ts` |

Suggested new modules, not existing paths: `src/main/computerUse/desktopProbe.ts`, `desktopSessions.ts`, and (for managed policy) `desktopBroker.ts`, with focused neighboring tests. Keep vendor-specific launch choices out of core plans.

## Delivery slices and acceptance

1. **Compatibility spike:** discover a pinned binary; run an observe → edit a harmless fixture → verify sequence from an actual hosted OMP/Skitarii chat on Windows and a hosted CLI on macOS. Record executable/helper versions, contract, permissions, target, and outcome. No runtime integration is claimed from this source review.
2. **Optional CLI integration:** disabled-by-default setting, diagnostics, instruction injection, private session setup and teardown. Verify a normal coding chat still starts when the tool is missing and that existing login/resume/custom-CLI behavior remains intact.
3. **Managed control and evidence:** explicit access scopes, coordination, cancellation, protection of DM human controls, and deliberate attachment export. Prove stale refs, partial snapshots, ambiguous windows, uncertain delivery, a timeout after delivery, denied permissions, two competing workers, quit/crash recovery, and secret-free logs.
4. **Broader host support and distribution:** validate each supported host's actual approvals/configuration, then optional MCP, pinned downloads/updates and offline packaging. If redistributing upstream code/binaries, preserve its Apache-2.0 license and applicable notices. Add FFI only if measurements justify it.

These are planning slices, not saved epics or tickets. The source-review spike has no implementation code, so tracking is optional under the repository's delivery standards; no Dark Mechanicus control endpoint was available in this session and no portable records were edited. Implementation must be planned through DM's sanctioned interface, with ticket-specific tests and the required checkpoint gate. Open choices are the first supported host/OS pair, direct-tool versus enforced-broker scope, distribution ownership, retention period, and the capability-schema rollout.

## Upstream references

All upstream references below use the reviewed revision:

- [README, installation and interfaces](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/README.md)
- [JSON contract and delivery reports](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/apps/docs/content/docs/json-output.mdx)
- [MCP interface and its access scope](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/apps/docs/content/docs/guides/mcp.mdx)
- [Sessions, namespaces and traces](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/apps/docs/content/docs/sessions.mdx)
- [Configuration and private state](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/apps/docs/content/docs/configuration.mdx)
- [Windows](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/apps/docs/content/docs/platforms/windows.mdx) and [macOS](https://github.com/vercel-labs/agent-desktop/blob/ab7dfb218cddc1594aa1d87a5bfcd0ac76da2276/apps/docs/content/docs/platforms/macos.mdx)
