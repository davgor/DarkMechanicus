# GUI agent wire protocols

DM-769, investigated 2026-11-24 on Windows. These are **normalized golden examples**, not a claim that every scenario was captured live. They pin the input for `claudeparse`, `ompparse` and `fakecli`; no vendor SDK becomes a runtime dependency. Private Ada implementation code was not copied.

## Evidence notation and sources

**O** means observed in the cited source (not necessarily on the wire). **I** means inferred, including deliberately synthetic fixture values, timing and omissions. A table's classification applies to **each named field**, including nested fields; any fixture field not expressly classified O below is I. Literal IDs, text, paths, counters and model names in fixtures are I, even where the field's shape is O. Optional fields omitted from a fixture are not assertions that the real CLI omits them.

Source aliases:

- `CT`, `CA`, `CL`, `CS`: `git show 87102b0c~1:src/main/agents/adapters/claudeTranscript.ts`, `claudeApprovals.ts`, `claude.ts`, `__mocks__/claudeSubagents.ts`. Historical repository source, available offline through Git. CS is a recorded real SDK stream, not a raw stdio recording. The SDK used the same CLI structured transport (`docs/reports/agents-fixes-e2e.md:74-79`).
- `SDK`: `@anthropic-ai/claude-agent-sdk` **0.3.331**, fetched with `npm pack …@latest` into OS temp only; no installation or lockfile change. Registry integrity: `sha512-ml/MPqgO95tG5zcApBFxEyoDk57d9htP09R8AtPbKPUCHpsobf84IjkN4zhGvQgk8zsA9dXoeMGrQcCc8gQE/w==`; SHA-1 `3d52acaf9e9bc44fae93b61cc05577ffba985f48`. Relevant type excerpts are reproduced below for offline review.
- `OMPDOC`: `docs/reports/omp-cli.md`, previously observed Windows OMP **18.16.0**.
- `MGR`, `IPC`, `HND`, `APR`, `EUI`, `RTR`, `WSM`, `CHAT`, `SUB`, `SEP`, `FAKE`, `RPCDOC`, `INT`: the **OMP RPC fact sheet attached to DM-769**, extracted 2026-11-20, targeting OMP 18.16–18.20. These are second-hand source observations, not files independently inspected in this attempt. Their original prefixes are `onebrief-harness/packages/desktop/src/main/pi-rpc-manager.ts`, `src/shared/ipc-contracts.ts`, `src/main/ipc/pi-handlers.ts`, `src/shared/tool-approval.ts`, `src/main/extension-ui-ipc.ts`, `src/main/pi-event-router.ts`, `src/main/workspace-manager.ts`, `src/renderer/src/chat/chat-state.ts`, `src/shared/subagent-task.ts`, `packages/contracts/src/session-endpoint.ts`, `packages/desktop/e2e/support/fake-a8s.mjs`, `docs/reference/rpc.md`, `docs/reference/engineering-harness-internals.md` respectively (desktop-relative paths after the first).

### Host observations and optional probes

- O: `%LOCALAPPDATA%/omp/omp.exe --version` exited 0: `omp/18.20.2`. `--help` exited 0 and listed `rpc-ui`, `--config`, `--no-tools` ("Disable all built-in tools"), `--no-session`, `todo`, `edit`, `write`, `ask` and `task`.
- O: launching that executable with `--mode rpc-ui`, no prompt, stdin closed immediately, exited 0. First stdout line was exactly:

  ```json
  {"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,"supportsBashExcludeFromContext":true}
  ```

  Other startup events included `extension_ui_request/setWidget`, `advisor_cost_changed` and `available_commands_update`. No model turn was requested. The ready values in the init fixtures are observed, not guessed.
- O: initial `where.exe claude` reported `INFO: Could not find files for the given pattern(s).` Native `%USERPROFILE%/.local/bin`, `.claude/local`, roaming npm and WinGet Links locations were absent; no Claude executable was found under Local Programs. Initial `claude --version` failed with `spawnSync claude ENOENT`. The ticket records historical `claude --help` **2.1.329**.
- O, subsequent orchestrator-provisioned help-only observation: official registry package `@anthropic-ai/claude-code-win32-x64@2.1.331`, verified integrity `sha512-bCT94qVLXKzQTofnw8UuAYU95C7rt6oS38Nr1cZfNc/eX+iZhG1oEvAwgmc9nsPf2QhP2Z93uT6bu3cY5Cw7Bw==`, extracted into `C:/Users/davgo/AppData/Local/Temp/dm-claude-help-KpIBFH/package/claude.exe`. `--version` printed `2.1.331 (Claude Code)`; full `--help` was captured as orchestrator artifact `artifact://195`, inspected by this worker. Only version/help ran: no model turn, credentials, login or memory probe. The relevant help text is reproduced under Arbiter so it remains reviewable offline. This is temporary official CLI provenance, not proof of the person's configured Claude install.
- Optional probe 1: unavailable. Launch prerequisite using `claude -p --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --forward-subagent-text` failed `spawnSync claude ENOENT`; `Reply with the single word OK` was never submitted. No model call or sign-in attempted.
- Optional probe 2: unavailable for the same `spawnSync claude ENOENT` prerequisite with `--settings`. No valid app-generated settings file or memory write was executed. `writeClaudeSettings` remains the settings generator (`src/main/terminals/claudeSettingsFile.ts:96-116`): O `autoMemoryDirectory`, `hooks.PreToolUse[].matcher`, `hooks[].type/command/args`. Whether this hook reaches the GUI host under `-p` is **unverified**, not inferred safe. No permission request, denial or successful memory write was observed.
- O: `omp -p --no-tools --no-session` with empty piped stdin/EOF exited 0 with empty stdout/stderr. This proves empty-EOF termination only, **not** consumption of a nonempty prompt or absence of MCP tools. No additional model turn was started.

## Launch and ownership

GUI Claude argv (host-built, not renderer supplied):

```text
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-prompt-tool stdio
  --forward-subagent-text --append-system-prompt-file <instructions>
  [--settings <writeClaudeSettings output>]
  (--session-id <uuid> | --resume <uuid>)
```

O: structured flags from historical SDK launch (`agents-fixes-e2e.md:76`, CL:522-537); O: partial messages and forwarding options CL:533-535. O (official 2.1.331 help observation above): `--forward-subagent-text` says "Forward subagent text and thinking blocks as assistant/user messages with parent_tool_use_id set (only works with --print and --output-format=stream-json)". That help also lists `--settings`, `--session-id`, `--resume`, `--input-format`, `--output-format`, `--include-partial-messages` and `--verbose`. I: direct `--append-system-prompt-file` spelling, per approved design, not independently exercised. Never use `--bare`, `--no-session-persistence` or `--dangerously-skip-permissions` for GUI chats. O: help's `--print` text explicitly says the workspace trust dialog is skipped in noninteractive mode and invalid settings are silently ignored. Tracking the folder is the application's trust decision; the memory hook still needs the optional live verification.

GUI OMP argv:

```text
omp --mode rpc-ui [--session <absolute-session-jsonl>]
  [--append-system-prompt <instructions-file>] [--config <settings-overlay>]
```

O: OMPDOC:93,98-108,138,145,178-179. `rpc-ui` is mandatory: `ask` is registered only with a host UI (MGR:54-55, INT:1112-1113,1144-1146). O: `--no-ui` leaves rpc-ui tool dialogs enabled (OMPDOC:129); it is not an approval bypass. Do not import Ada's `--profile a8s` or `ONEBRIEF_*` environment into plain OMP launches. O: OMP mints the session id, learned from `get_state`, rather than accepting `--session-id` (OMPDOC:169; FAKE:148-149).

Design invariants: pin canonical cwd in main; env-only `DM_SESSION_TOKEN`; mask claim tokens **and** `dmg_` grants before any persistence/IPC, including stderr and status strings; raw JSONL never crosses IPC. These are requirements, not outcomes established by this data-only ticket.

### JSONL process runner (DM-775)

`startAgentProcess` accepts the main-owned executable, argv, cwd and environment. It uses piped stdio without shell command evaluation, hides Windows console windows, and creates a POSIX process group. On Windows a fixed system PowerShell supervisor creates the CLI suspended, assigns it to a non-inheritable kill-on-close Job Object, then resumes it; descendants inherit that ownership from birth. The CLI inherits binary stdio directly, and cwd/environment stay on the process spawn (not serialized into script arguments). The fixed helper source is bundled in the TypeScript module, independent of working directory or source files. `pid` is the owned supervisor PID on Windows; exit code remains the CLI's. Assignment/resume failures terminate the suspended child rather than run it without ownership. `onLine` delivers UTF-8 LF frames with a trailing CR removed and flushes a final unterminated frame. Frames above 8 MiB are discarded through LF with one diagnostic per discarded frame.

The Windows supervisor command is fixed-size. Executable and quoted command-line data travel first on its owned stdin as a `DMJ1` frame: 4-byte magic, two little-endian uint32 UTF-8 byte lengths, then executable and command bytes. Lengths allow the full CreateProcess limit (32,766 UTF-16 code units plus terminator), not an 8 KiB subset. Native exact reads handle short reads without buffering beyond the frame; malformed, oversized, truncated, invalid UTF-8 or NUL-bearing metadata fails before launch. The runner queues metadata before exposing writes/EOF, and the child inherits the remaining pipe bytes unchanged. No launch metadata files, environment keys, or variable command-line encoding are needed.

`onStderr` supplies the current last 64 KiB of diagnostics; `onExit` supplies `{code, signal, stderr}` after both output pipes close, including to late subscribers. All subscriptions return an unsubscribe function. These are main-only raw values: session owners must mask them before persistence or IPC. `write` appends LF and returns false when stdin is closed, including EPIPE; the eventual exit callback retains the real exit code.

`stop` is idempotent: end stdin, escalate a live owned process through `killProcessTree` after 3 seconds, and bound disposal at 5 seconds with a diagnostic if shutdown could not finish. POSIX group cleanup starts immediately on natural exit and its result is retained for later disposal, avoiding a delayed lookup of a reused group ID. On Windows the supervisor terminates its retained job when the CLI exits, including descendants that survive stdin EOF; killing the supervisor also closes the job. This launch-time ownership avoids the unrecoverable ancestry races in stop-time process enumeration. A deadline diagnostic is not proof that an unkillable process has exited.

### Surface ownership (DM-780)

`ChatRecords.createChat` chooses GUI for the connected Claude/OMP kind and terminal for every other kind, centrally for every caller. Authentication is still checked at launch. A record without `surface` remains terminal.

`setSurface` preserves the vendor session identity and starts no replacement process. GUI turns, queued turns, pending prompts and starts refuse with `busy`; unsupported GUI kinds refuse with `unsupported`. A successful change waits for process close, transport/tree cleanup and grant revocation before storing the surface and calling `onChatChanged` once. Both owners expose reservations through `isLive`; a competing start refuses with `busy_elsewhere`. Bootstrap connection of these dependencies belongs to DM-781.

Live terminal activity is not observable through the current PTY contract. Claude 2.1.331 help exposes structured output only in print mode; its documented status-line fields contain no idle/finality flag, and Stop hooks can precede continued work or be absent on interrupt. Until an approved activity/confirmation contract exists, a live terminal is conservatively refused rather than called idle. This does **not** satisfy live-idle terminal-to-GUI switching; exited terminals can switch and resume their saved session. No ANSI timing or transcript heuristic substitutes for that missing proof.


## Claude host → CLI

### Control envelopes and initialization

O: SDK `sdk.d.ts:5569-5575,5620-5622,424-433,453-462` (verbatim relevant declarations, comments omitted):

```ts
export declare type SDKControlRequest = {
    type: 'control_request';
    request_id: string;
    request: SDKControlRequestInner;
};
export declare type SDKControlResponse = {
    type: 'control_response';
    response: ControlResponse | ControlErrorResponse;
};
declare type ControlResponse = {
    subtype: 'success';
    request_id: string;
    response?: Record<string, unknown>;
};
declare type ControlErrorResponse = {
    subtype: 'error';
    request_id: string;
    error: string;
};
```

Every response echoes the **sender's `request_id`**, inside `response`, not at top level. A permission refusal is a successful control exchange containing `behavior:'deny'`; it is not an envelope error.

O: SDK `sdk.d.ts:4941-4944,5049-5060`:

```ts
declare type SDKControlInitializeRequest = {
    subtype: 'initialize';
    hooks?: Partial<Record<coreTypes.HookEvent, SDKHookCallbackMatcher[]>>;
    sdkMcpServers?: string[];
    // Additional optional fields omitted here.
};
export declare type SDKControlInitializeResponse = {
    commands: coreTypes.SlashCommand[];
    agents: coreTypes.AgentInfo[];
    output_style: string;
    available_output_styles: string[];
    models: coreTypes.ModelInfo[];
    account: coreTypes.AccountInfo;
    // Additional optional fields omitted here.
};
```

O: packed `sdk.mjs:168` builds `{subtype:"initialize",hooks:this.initHooksPayload,sdkMcpServers:t,…}`. **I: whether bare CLI stream-json strictly requires initialize before the first user turn is not established by these sources.** This host contract requires sending it once and awaiting its correlated success before admitting a turn; do not confuse `system/init` with that control reply. `init.in/out` pin both. No `--await-initialize` requirement is assumed. Fixture empty `account` and model lists are projections, not complete SDK account objects.

| Host line / fields | Meaning and provenance |
| --- | --- |
| `type:user`, `message.role:user`, `message.content` string or blocks; `session_id`, `uuid`, `parent_tool_use_id:null` | O: CS:908-925 for envelope and content blocks; I: chosen outbound plain text envelope, deterministic UUID/session substitutions and null parent. Text-only GUI composer is required. |
| `type:control_request`, `request_id`, `request.subtype:interrupt` | O: SDK excerpts below. Response is `control_response` with success and `{}` on older CLI. |
| `type:control_response`, `response:{subtype:success,request_id,response:{behavior:allow,updatedInput}}` | O: SDK PermissionResult below; CL:686-694 confirms allow/deny behavior. |
| Same, with `behavior:deny,message` | O: SDK/CL; no question is automatically denied. |
| Same, with `updatedPermissions` | O: SDK; copy only CLI-offered `permission_suggestions`, using destination `session`. The fixture uses offered addRules. Never manufacture persistent rules. |
| Second `user` line during an active turn | I: queue timing. O: `queued_turn_count` exists; no invented Claude `follow_up` command. `queued.out` stops at the first turn's result with a queued successor, not a second completed turn. |

O: SDK `sdk.d.ts:5124-5130,5139-5152` relevant excerpt:

```ts
declare type SDKControlInterruptRequest = {
    subtype: 'interrupt';
    cancel_queued?: boolean;
};
// Advertised by interrupt_receipt_v1; older CLIs send an empty success response.
export declare type SDKControlInterruptResponse = {
    still_queued: string[];
    cancelled?: string[];
};
```

`interrupt.in/out` uses the older `{}` receipt. I: exact result timing on interruption. O: SDK `sdk.d.ts:10705` includes terminal reasons `'aborted_streaming' | 'aborted_tools' | … | 'completed'`; the fixture uses `aborted_streaming`, not a fabricated `interrupted` subtype.

### Permissions and questions

O: SDK `sdk.d.ts:5331-5337,5374-5379`, relevant declarations:

```ts
declare type SDKControlPermissionRequest = {
    subtype: 'can_use_tool';
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: coreTypes.PermissionUpdate[];
    blocked_path?: string;
    title?: string;
    display_name?: string;
    tool_use_id: string;
    agent_id?: string;
    description?: string;
    // Additional optional fields omitted here.
};
```

O: SDK `sdk.d.ts:2724-2735,2743-2747,2772`:

```ts
export declare type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdate[];
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
} | {
    behavior: 'deny';
    message: string;
    interrupt?: boolean;
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
};
// One PermissionUpdate variant:
// { type: 'addRules'; rules: PermissionRuleValue[];
//   behavior: PermissionBehavior; destination: PermissionUpdateDestination; }
// PermissionRuleValue = { toolName: string; ruleContent?: string }
export declare type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
```

`approval_chat` copies the offered `{type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo hello'}],behavior:'allow',destination:'session'}` into `updatedPermissions`. `approval` omits it. O: recorded CS:890-902 also offers `{type:'setMode',mode:'acceptEdits',destination:'session'}`; don't assume suggestions always use addRules. I: GUI offers chat-wide choice only when a suitable suggestion exists (approved policy). Newer SDK `suppress_always_allow_rule` (5331-5360) also prohibits persistent affordances when true.

O: CA:31-34 establishes `AskUserQuestion` reaches `canUseTool`; old denial there is **not** the new policy. The request has `tool_name:'AskUserQuestion'`, `input.questions`, and the host allows with `updatedInput = {...input, answers}`. O: SDK `sdk-tools.d.ts:1142ff,2675-2686` includes `questions`, question `multiSelect:boolean`, and:

```ts
/** User answers collected by the permission component */
answers?: {
  [k: string]: string;
};
```

I: question-text key → chosen label encoding in the fixture (`{'Which database?':'SQLite'}`), and `question/header/options[].label/description` values. The declaration establishes the map shape, not every serialization detail of multiple selections. Preserve the original input when adding answers.

### Pending prompt ownership (DM-779)

Main replays only the FIFO head of the translator-held queue. Later requests remain held; OMP `cancel` removes its target, and exit clears the queue immediately without changing the process-close/transport/grant cleanup barrier. Unknown, queued or withdrawn ids fail with typed `stale_prompt` and write nothing. There is no timeout answer or remembered host-side `allow_chat` policy.

The optional main-only `arbitrate` dependency receives each newly exposed head, including questions for the later policy gate to escalate. Pending snapshots/pushes expose `deciding`, `off` or `escalated`; a question cannot be answered by an approval verdict. Allow-once/deny verdicts use the same answer encoder as a person, with masked, 500-character-bounded `decidedBy: magos` reasons. A successful person answer cancels arbitration; late results, including those after withdrawal or exit, are fenced out. Renderer answers cannot supply provenance or choose a Magos `allow_chat`.

Approval and question requests are stored as `approval_request`, with translator thread attribution. Question steps store `approval_decision: allow_once` and a `user_message` containing selected labels or free text. OMP `secret` answers exist only in the outgoing CLI frame, never in those user messages. Multi-question steps retain their wire request while exposing distinct prompt ids.

## Claude CLI → host field inventory

| Event and fields | Evidence / interpretation |
| --- | --- |
| `system/init`: `type,subtype,session_id,uuid,cwd,tools,model,permissionMode,mcp_servers` | I: normalized init projection; SDK init control response is separately O above. No raw startup line captured locally. |
| `stream_event`: `event,session_id,parent_tool_use_id,uuid` | O: CS:1081-1104,1180-1196. |
| `event.type:message_start`, `event.message.id/type/role/content/model/stop_reason` | O: CS:1083-1098. IDs key deltas to final text. |
| `content_block_start`, `index`, `content_block.type/text/thinking/signature` | O: CS:1108-1122,1163-1178. |
| `content_block_delta`, `index`, `delta.type:text_delta`, `delta.text` | O: CS:1183-1196. |
| `delta.type:thinking_delta`, `delta.thinking`; `input_json_delta`, `partial_json` | I: standard Anthropic partial-event projection; not captured in the inspected local stream excerpts. Never persist partial argument JSON as a completed tool call. |
| `content_block_stop/index`; `message_delta/delta.stop_reason`; `message_stop` | O: CS:1665-1708. |
| `assistant`: `message.id/type/role/model/content/stop_reason`, `parent_tool_use_id,session_id,uuid` | O: CS:849-880,958-981. Text blocks `type,text`, tool blocks `type:tool_use,id,name,input`. Assistant can arrive one block at a time for the same message id (CT:4-8,305-314); don't duplicate streamed text. |
| `user.message.content[]`: `type:tool_result,tool_use_id,content,is_error` | O: CS:905-925; `content` can be string or text blocks (CS:1020-1034). Tool end, not a fresh user bubble. |
| `Agent` / legacy `Task` tool `input.description,prompt,subagent_type` | O: CT:14-24,109,342-354. Parent link is envelope `parent_tool_use_id`, **not** a property guessed from the description. |
| `tool_use_result.status:async_launched`, `agentId`; `system/task_notification.task_id,tool_use_id,status,summary,output_file` | O: CT:173-180, CS:998-1014. Worker remains live after main result unless its own completion arrives. I: ordering/async launches in fixture. |
| `control_request` approval/question | O: full envelopes above. It carries the request id, not a ChatItem id. |
| `result.type,subtype,is_error,result,session_id,uuid,duration_ms,duration_api_ms,num_turns,total_cost_usd` | O: CS:1724-1768. Durations/cost zeros are I. |
| `result.usage,modelUsage,permission_denials,stop_reason,queued_turn_count` | O: SDK excerpt below; fixture usage is a minimal projection. |
| Error `result.subtype:error_during_execution,is_error:true,errors[]` | I: failure fixture projection; error `result` behavior O: CT:46-56,280-282. Do not turn a control error into a successful turn. |

O: SDK `sdk.d.ts:6492-6520,6539-6540`, relevant excerpt:

```ts
is_error: boolean;
num_turns: number;
result: string;
stop_reason: string | null;
total_cost_usd: number;
usage: NonNullableUsage;
modelUsage: Record<string, ModelUsage>;
permission_denials: SDKPermissionDenial[];
queued_turn_count?: number;
uuid: UUID;
session_id: string;
```

### To-dos and file tools

O: SDK `sdk.d.ts:234` BUILT_IN_TOOL_NAMES contains `'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskUpdate', 'TodoWrite'`. **Which family a real `claude -p` turn chooses is I/unobserved**, so both families are pinned, not asserted mutually exclusive.

- I: `TodoWrite.input.todos[] = {content,activeForm,status}`, statuses `pending/in_progress/completed`; successful result wording `Todos have been modified successfully.` The `todo` fixture has two successive updates and a third inside a forwarded subagent. `todo_fail` carries `is_error:true` and must stay visible.
- I: `TaskCreate.input = {subject,description,activeForm}` and exact fixture result text `Task #1 created successfully: Task 1` / `Task #2 created successfully: Task 2`. These strings were required by the amendment, not observed from a live run. `TaskUpdate.input = {taskId,status}` with `1:in_progress`, `1:completed`, and unknown `99:completed`. Unknown id must not invent a task; failed update stays visible.
- O: Claude `Edit`, `Write`, `MultiEdit`, `NotebookEdit` names and `file_path` / `notebook_path` keys CA:19,73-75; actual Write input `file_path,content` CS:859-865. I: `Edit.old_string/new_string`, `NotebookEdit.new_source/edit_mode/cell_type` fixture arguments. Paths are kept verbatim after masking, not normalized into cwd-relative guesses. Fixture cwd is `C:\fixture\repo`.

## OMP framing and host → CLI

O: one LF-delimited JSON object per line, stderr separate (MGR:46,52,1308; RPCDOC:15,22). Reader strips CR, accepts final unterminated line, skips blanks (MGR:1374-1400). Invalid JSON is reported, not treated as model text (MGR:1425-1429). EOF closes the process (RPCDOC:16). No `/quit` pseudo-command.

| Command / each field | Evidence |
| --- | --- |
| `negotiate_protocol {id,protocolVersion:2}` | O MGR:1444-1446. Send after ready advertises 2, before either side chunks. |
| `set_ask_dialog {id,enabled:true}` | O WSM:944-954; asks become one question card. |
| `set_subagent_subscription {id,level:progress}` | O WSM:955-957, SUB:326. |
| `set_event_filter {id,events:null,messageUpdates:delta}` | O WSM:958-960; old versions may refuse. |
| `get_state {id}` → `data.model,thinkingLevel,isStreaming,isCompacting,steeringMode,followUpMode,sessionFile,sessionId,sessionName,autoCompactionEnabled,messageCount,pendingMessageCount,todoPhases` | O FAKE:140-155. `init` empty todos; `init_resume` nonempty. Nested phase shape I below. |
| `prompt {id,message}` | O HND:118-130, IPC:1010-1028. Admission response is not completion. `streamingBehavior:followUp` also observed; images deliberately unused in v1. |
| `follow_up {id,message}` / `steer {id,message}` | O HND:132-147. Mid-turn second message uses follow_up; `queue_update` reports it. |
| `abort {id}` | O HND:149-151, FAKE:179-181. |
| `get_subagent_messages {id,subagentId,fromByte}` → `data.messages,nextByte,reset` | O fact sheet `subagent-transcripts.ts:117-128`. The host must retain request-id → subagentId correlation to route returned messages. Byte offset is opaque; fixture 512 is I, not a byte-count assertion about timestamp-stripped projections. |
| `extension_ui_response {id,...answer}` | O MGR:1357-1364, **no response acknowledgement**. `id` is the UI request's id. |
| General reply `type:response,command,id,success,error?,data?` | O IPC:726-733. `command` echoes type, `id` echoes id; `success:false` is a command error, not text. |

### rpc_chunk in both directions

O: MGR:157-171,182-270: `{type:'rpc_chunk',chunkId,index,count,byteLength,data}`. `chunkId` 1–128 chars; index starts at zero and increases consecutively; count ≥2; byteLength is the total UTF-8 byte count of **one entire serialized object**. `data` is padded standard base64 of raw byte slices, not fragments of decoded text. Reject malformed base64, interleaving, mismatched counts/lengths, and overflow; reassemble bytes before UTF-8/JSON decoding. No other frame interleaves (MGR:1422-1424). O default limits 1 MiB frame, 64 MiB reassembled; observed ready matches those. I: opt-in is necessary inferred from MGR:1444-1446. The `chunked` pair intentionally uses two small chunks on each side for deterministic coverage; real senders only need to chunk oversized frames. Init negotiation must be replayed first. Fake turn renumbering must **decode/re-encode chunks and recalculate byteLength**, not replace text inside base64.

## OMP CLI → host inventory

| Event / each field | Evidence |
| --- | --- |
| `ready`: `protocolVersion,supportedProtocolVersions,maxFrameBytes,maxReassembledFrameBytes,supportsBashExcludeFromContext` | O live 18.20.2 frame above; first four documented by MGR:1432-1447. Last capability may be ignored. |
| `agent_start`; `agent_end.messages[]` | O IPC:602-609. End of run, not necessarily background worker end. |
| `turn_start`; `turn_end.message,toolResults[]` | O IPC:674-682; I placement in fixtures. |
| `message_start.message`, `message_end.message` | O IPC:952-960; full final content on end. |
| `message_update.message`, `assistantMessageEvent.type/contentIndex/delta/partial/block/message/toolCall` | O IPC:617-643, CHAT:222-282. Types `start,text_start,text_delta,text_end,thinking_start,thinking_delta,thinking_end,toolcall_start,toolcall_delta,toolcall_end`. Delta mode omits partial; start carries message; block starts carry block. No CLI `offset`. |
| text block `type:text,text`; thinking `type:thinking,thinking`; tool `type:toolCall,id,name,arguments` | O IPC:1353-1370. `toolcall_delta.delta` is partial JSON arguments; toolcall_end supplies finalized `toolCall`. |
| assistant message `role,content,api,provider,model,usage.input/output/cacheRead/cacheWrite/cost.input/output/cacheRead/cacheWrite/total,stopReason,errorMessage?` | O IPC:1381-1404. `stopReason:stop/aborted/error` O CHAT:184-197; `toolUse` I. Real messages include timestamp; removed from fixtures by requirement. |
| toolResult `role,toolCallId,toolName,content,isError` | O IPC:1406-1415; timestamp stripped. `get_subagent_messages` supplies child tools in subagent fixtures; don't invent nested execution event fields. |
| `tool_execution_start.toolCallId/toolName/args` | O IPC:645-650. |
| `tool_execution_update.toolCallId/toolName/args/partialResult.content/details` | O IPC:652-661. |
| `tool_execution_end.toolCallId/toolName/result.content/details/isError` | O IPC:663-672. I approval-vs-start ordering and toolCallId matching call id (desktop keys both alike). |
| `subagent_lifecycle.payload.id/agent/description/status`; `task` | O IPC:1065-1075, SUB:377-402 for listed lifecycle fields; lifecycle `task` I, progress `task` O. |
| `subagent_progress.payload.agent/task/progress.id/status/description` | O IPC:1065-1075, SUB:377-402. Full payload unknown. **Parent-link field unobserved: omitted**, not guessed. Nested reviewer appears as an unparented thread until actual linkage is known. |
| `queue_update.steering[],followUp[]` | O IPC:684-688. Empty arrays clear queues; queued fixture holds one second message at first turn end. |
| `prompt_result.id?,agentInvoked,status,error.message` | O IPC:998-1008,1041-1056. Status `completed/aborted/error`; follows agent_end. No agent_start plus agentInvoked false means local command/no model turn. |
| `extension_error.extensionPath/event/error`; `response.success:false/error`; assistant `stopReason:error/errorMessage` | O IPC:719-733, CHAT:184-193. Prompt-level error below is the terminal result; avoid duplicate errors. |
| `compaction_start.reason`, `compaction_end.reason/result/aborted/willRetry/errorMessage?` | O IPC:690-702; status only. |
| `auto_retry_start.attempt/maxAttempts/delayMs/errorMessage`, `auto_retry_end.success/attempt/finalError?` | O IPC:704-717; status only, not host retry authority. |
| `session_info_update.title?/sessionId?`, `available_commands_update.commands`, `command_output.text`, `config_update.model?/thinkingLevel?` | O IPC:971-996,1058-1063. Session/status metadata. |
| `todo_auto_clear` | O IPC:1077-1080. Empty ephemeral todos; no persistent transcript row. |

Abort tail: O final `stopReason:aborted,errorMessage:'Interrupted by user'` (CHAT:175-182); I exact `response → message_end → turn_end → agent_end → prompt_result` ordering. Process-level nonzero exit/stderr is a separate startup failure; never fabricate a JSON error frame from stderr without masking.

### Extension UI: every method and response

O request fields (IPC:767-797): `type:extension_ui_request,id,method,title?,message?,options?,placeholder?,secret?,prefill?,timeout?,questions?,form?,notifyType?,statusKey?,statusText?,widgetKey?,widgetLines?,widgetPlacement?,url?,launchUrl?,instructions?,purpose?,callbackUrl?,targetId?`. Fields are method-specific; don't require all of them. O blocking/fire-and-forget split RTR:36-43:

| Method | Class | Host answer / treatment | Evidence |
| --- | --- | --- | --- |
| `select` | blocking | `{type:extension_ui_response,id,value:<exact option>}` | O EUI:155 |
| `confirm` | blocking | `{…,confirmed:true|false}` | O EUI:156 |
| `input` | blocking | `{…,value:<text>}` | O EUI:157-158 |
| `editor` | blocking | `{…,value:<text>}` | O EUI:157-158 |
| `ask` | blocking | `{…,answers:[{id,selectedOptions:string[],customInput?}]}` in question order | O IPC:755-762, EUI:110-127 |
| `form` | blocking | `{…,data:{fieldName:string|number|string[]}}` | O IPC:764-765, SEP:345-353 |
| `notify` | fire-and-forget | no answer; notice via message/notifyType | O RTR:36-43, IPC:767-797 |
| `setStatus` | fire-and-forget | no answer; statusKey/statusText | O same |
| `setWidget` | fire-and-forget | no answer; widgetKey/widgetLines/widgetPlacement | O same |
| `setTitle` | fire-and-forget | no answer; title | O same |
| `set_editor_text` | fire-and-forget | no answer; prefill/text mapping not established (I) | O method RTR:36-43 |
| `open_url` | fire-and-forget | no protocol answer; never automatically open untrusted URL | O fields IPC:767-797; host policy I |
| `cancel` | fire-and-forget | withdraw pending `targetId`, not the cancel event's own id | O RTR:296-302 |

O: `secret` requests conceal sensitive input (field IPC:767-797); I precise method combinations. Never echo secret answers into ordinary transcript or logs. `{cancelled:true}` is O for ask/form (EUI:106-136), I for select/input/editor; don't assume stock OMP accepts it universally. Dropping any blocking method silently deadlocks the turn (EUI:186-189); unsupported methods need visible unresolved handling, not auto-answer.

**Tool permission recognition:** O APR:3-26: `select`, last option exactly `Deny`, and an earlier `Approve` or `Approve Once`. Send the offered exact label back. A session-grant option is not universal; `approval_chat` offers and selects `Approve bash for this session`. Options are protocol values, never translated. Other selects remain questions. I: approval timing relative to execution start.

**Question shape under rpc-ui:** O IPC:737-753, WSM:944-946: with `set_ask_dialog`, `method:ask`, `questions:[{id,question,header?,options:[{label,description?,preview?}],multi?,recommended?}]`, recommended is an index. Free text is allowed. `secret`, cancel and unsupported methods still require correct pending ownership. O: on 18.18 Ada's `ONEBRIEF_RPC_FORMS=1` produces a form, not proven stock-OMP behavior (INT:1113-1117). Form fields O SEP:170-255: sections `{title:[{text,style?}],blocks}`, fields `choice:{kind,name,question,label,multi,select,other,required,options:[{value,label,checked,disabled}]}` or `text:{kind,name,question,label,type,multiline,rows,value,placeholder,required,min?,max?,pattern?,minLength?,maxLength?}`; style `code|strong|em`. Do not enable Ada-only flags in this host.

### OMP to-dos and file paths

- O: tool name `todo`, `edit`, `write` in installed 18.20.2 help. O envelope `tool_execution_end.result.details` above. **I: `details.phases` nested shape** `[{id,name,tasks:[{id,content,status,blocker?}]}]`; fixture includes two phases, `in_progress`, `blocked` with `blocker`, and `abandoned`. Neither these phase field names nor exhaustive statuses were established by the fact sheet; consumers must preserve this inference boundary rather than claim live validation.
- O: `get_state.data.todoPhases` (FAKE:140-155); I nested shape same as fixture above. `init_resume` is an alternative startup pair with nonempty todos, not a second ready emitted mid-session.
- O: `todo_auto_clear` (IPC:1077-1080). Failed `todo` (`isError:true`) stays visible and must not replace successful state; successful calls are hidden after applying todos.
- I: `edit`/`write` use path argument `path`; `edit.old_text/new_text`, `write.content` are synthesized fixture input shapes, not an observed stock OMP edit syntax. The Changes contract only consumes the path. Other OMP edit mechanisms (`ast_edit`, shell, apply-patch text) are not assigned invented path keys.

Renderer consumption: `src/renderer/src/agentChat/agentChanges.ts` derives Changes from completed file calls in transcript order. Chat scope includes all threads; worker scope includes nested helpers. Rows count touches and use the newest tool, not git added/modified status. Paths are normalized lexically and compared case-insensitively on Windows drive paths; project-less paths stay marked outside. Shell edits remain invisible. This derivation does not upgrade the inferred OMP path keys to observed protocol facts.

### Shared to-do normalization

`src/main/agentChat/todoLists.ts` implements the host's pure validation boundary without changing the inference labels above. `todoWritePhases(input)` accepts the complete TodoWrite input; `ompTodoPhases(value)` accepts the phase array extracted from either successful `result.details.phases` or `get_state.data.todoPhases`. A malformed task rejects the entire replacement (`null`): retain the prior state and count one skipped line. Limits are 20 phases and 100 tasks across the list. Free text is secret-masked before clipping (500 characters for task text, 200 for phase names, including the ellipsis); blockers survive only for blocked tasks.

For incremental Claude tools, initialize `TaskList` as `{tasks: [], pendingCreates: {}}`. `taskCreateStarted` retains a validated subject/activeForm under the tool-use id; `taskCreateResult` consumes that pending entry and binds the numeric id from `Task #N`, or uses `null` when none is usable. Apply results only for successful tool calls. `taskUpdate` returns `{list, skipped}` and preserves the original list on invalid status or unknown id; `deleted` removes the task. `taskPhases` returns one unnamed phase. All helpers are immutable; state is owned by the caller per thread, and failed tool calls remain the translator's responsibility.

## Fixture catalog and replay

Root: `src/main/agentChat/__fixtures__/`. Each entry has `.in.jsonl` (host writes) and `.out.jsonl` (CLI writes):

- Both protocols: `init`, `text`, `tool`, `subagent`, `approval`, `approval_chat`, `question`, `interrupt`, `error`, `queued`, `subagent_tree`, `todo`, `todo_fail`, `edit`.
- Claude additionally: `tasks`, `worker_approval`.
- OMP additionally: `chunked`, `todo_clear`, `init_resume`, `worker_claim`.
- Total: **34 pairs / 68 files**. Init/ready/negotiation/subscription/state bootstrap lives only in startup pairs; `init_resume` replaces `init` for resume. Scenario files cover one top-level turn; `queued.in` also admits its queued successor but `queued.out` does not execute it.
- Replay cross-direction ordering: emit until permission/question, wait for matching answer; interrupt input follows partial text; queued second input follows first stream activity; OMP subagent transcript-tail command follows lifecycle/progress. Lists alone do not mean write every input before output. IDs and tool results carry the correlation.
- Every transport/session/message/tool/thread/question/chunk id contains `T1`. Two **binding-amendment exceptions** are deliberate: TaskUpdate's semantic task keys `1`/`99` (and TaskCreate result numbers), and the exact synthetic attempt ids inside fake claim tokens. These are not renumbered transport ids. The fixed fake tokens are `at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA` and `at_01j0000000000000000000000b.fixtureSecretBBBBBBBBBBBBBBBBBBB`; **no secret contains T1**. They are public noncredential test data, never real attempt secrets.
- `subagent_tree`: each worker has one tool result; worker 1 completes, worker 2 stays running after result. Claude nested reviewer has worker 2's parent_tool_use_id. OMP parent linkage is intentionally absent because unobserved; its description is not proof of a parent.
- No timestamp fields. Real timestamp-bearing messages are normalized projections, not full API schema fixtures. Synthetic durations and offsets are stable. Fixture paths are non-sensitive Windows absolute paths inside `C:\fixture\repo`, or relative read paths.
- `.gitattributes` forces LF for JSONL and future fake `.mjs`. Do not run repository-wide `git add --renormalize`: selective commit policy supersedes that ticket command. Files are written LF directly, and the targeted index/worktree EOL check is performed after selective commit.

| Worker fixture | Provenance and purpose |
| --- | --- |
| Claude `worker_approval.in/out` | **Synthetic, derived from the `subagent` and `approval` goldens**: raw fake claim in an Agent prompt, child Bash approval correlated by `parent_tool_use_id`/`tool_use_id`, then completion after the answer. |
| OMP `worker_claim.in/out` | **Synthetic, derived from the `subagent` golden**: lifecycle opens the worker without task text; progress supplies the raw fake claim. The first raw task is inspected independently of thread creation, and repeated progress/completion emits no duplicate claim. |

Translators return `internalEvents` separately from public `events`. A `ThreadClaimEvent` contains
`{type:'thread_claim', threadId, attemptId, token}` in main memory only; never log, persist, or push it.
Two distinct complete tokens (including different secrets for the same attempt) yield no claim.
This extraction is not verification: DM-812 must verify the token and run ownership before calling
`ActivityBindings.bind`, then discard it. Bindings persist only validated worker attempt ids and reject
token-bearing input, including unknown fields. The public `AgentChatEvent` schema rejects `thread_claim`.

### Deterministic fake CLI

Run `node src/main/agentChat/__fixtures__/fakeAgentCli.mjs` with the GUI argv above, or without print/RPC flags for the echoing TUI. Set `FAKE_AGENT_LOG` to an isolated invocation log and `CLAUDE_CONFIG_DIR` to a scratch profile. The log includes only argv, cwd, pid and grant presence; `[leak]` deliberately sends the env grant in a tool result and stderr for downstream masking tests.

The shebang is retained, but the `.mjs` is a Node input script, not a directly executable agent path: subprocess tests use `{ file: process.execPath, args: [FAKE_CLI, ...] }`, with no committed executable-bit requirement. Consumers needing an executable agent path use DM-777's generated Windows npm-style shim or executable POSIX `sh` launcher that runs Node, matching DM-791. Do not execute the `.mjs` directly.

`[scenario_name]` selects any existing protocol `.out.jsonl`; unknown names select `text`. `[slow]` spaces text frames by 200 ms, `[crash]` exits 3, OMP `[tasks]` aliases `todo`, and Claude `[todo_clear]` aliases `text`. Send the golden initialization commands first. Blocking permission/question requests require their matching response id. Subsequent turns renumber wire ids, including ids inside chunk payloads; input received during a turn is replayed afterward. EOF stops even a pending approval or slow turn.

OMP subagent transcript responses wait for `get_subagent_messages` for the corresponding worker and echo the caller's request id, rather than emitting unsolicited golden ids. `follow_up` and `steer` acknowledge admission immediately with their own command/id and a queue snapshot; the later turn does not emit a second `prompt` acknowledgement. Dequeuing publishes the updated queue. The `queued` golden test drives its real follow-up command and checks both the byte-identical first turn and the subsequent replay.

Arbiter print argv selects deterministic `allow`, `deny`, `escalate`, `garbage`, `fenced`, `hang` or `crash`, using `FAKE_ARBITER_VERDICT` before the first `[arbiter:verdict]` in stdin. Arbiter logs are written after EOF and before output, include only a `stdinHasSecret` boolean, and never create session files. The fake OMP arbiter is test machinery, not evidence that real OMP arbitration is supported.

`fakeAgentCli.test.ts` compares every checked-in scenario, including the worker fixtures, exercises session detection and both arbiter envelopes, and also verifies generic `worker_approval` replay using an isolated copy of the existing approval golden.

### Main-process session lifecycle

`agentChatSessions.ts` owns GUI children independently of view attachment. It checks authentication and the canonical folder, writes the existing terminal start files, issues and records grants, initializes the protocol and binds grants before submitting the first turn. Terminal ownership refuses a GUI start. A saved first prompt is reserved as uncertain before writing and marked submitted only afterward; restarting never automatically replays uncertain input.

Only translated item events enter the chat store. Deltas, stream endings and per-thread to-dos are pushed but not persisted; to-dos remain available after exit and reset on the next process start. All stored and pushed values, including the 2 KiB stderr status tail, pass the GUI secret masker. Internal claim events stay outside that public path. Hourly renewal, minute folder validation and keep-awake last only while the process runs; stop, delete, exit and disposal revoke its grants.

The disk-backed `agentChatRig` uses the real host platform and `fakeAgentShim.ts`. Windows generates a CRLF npm-style `.cmd` plus a JS loader using `pathToFileURL`; POSIX generates an executable `sh` launcher with safely quoted `exec node … "$@"`. Native launcher tests cover spaces and argument preservation; Windows inspects, but does not claim to execute, the POSIX contract.

OMP's synthesized message/error/stopped IDs carry a fresh process-generation namespace, including their matching delta and stream-end IDs; provider tool, thread and session identifiers are unchanged. This keeps old responses distinct after both process and application restarts. Restart callers share one reserved start while the old owner remains tracked until close and grant revocation complete. Stop/delete/dispose await that completion, not merely process exit; a missing close fails at the existing five-second shutdown bound rather than reporting successful cleanup. Failed Claude initialization settles startup and stops its child. Exit also pushes `pending:null` so attached views retire actionable cards.

A shutdown deadline remains a failure for its original caller. Cleanup has a separate completion barrier: the retained transport's `stop()` must complete, close must arrive, and grant revocation must succeed before ownership is released. This also applies to natural exits, whose close notification can precede process-tree cleanup. Only that composite success permits later stop/restart/delete operations to recover from an expired deadline; rejected transport cleanup or revocation remains failed. A failed disposal permits a later explicit disposal check, while the manager remains closed to new starts.

`send(ref, {text})` lazily starts a stopped GUI owner through that same cleanup barrier and uses the persisted session's `--resume` launch. Each accepted transport write is immediately echoed as one masked `user_message`; rejected writes produce no echo or queue mutation. Claude sends another user line while busy and counts it until the next main response starts; OMP uses `follow_up` and its `queue_update` events are authoritative. Snapshots retain the current queue count.

Claude queue accounting consumes each queued turn once: on its first main text/tool activity, or on its terminal result when it produced no assistant output. Forwarded subagent activity does not consume a main queue entry. An explicit `queued_turn_count` in a result is authoritative and replaces, rather than duplicates, inferred consumption.

`interrupt(ref)` writes Claude's control interrupt or OMP's abort without stopping an idle chat. A turn completion cancels the five-second watchdog. If the original turn does not finish, the watchdog forces the retained process-tree owner to stop immediately, keeps the chat failed and resumable, and still waits for the original composite cleanup barrier. Repeated interrupts do not extend the deadline. The main-only transport's `stop({force:true})` also escalates an already-pending graceful stop without changing its promise or looking up an ended process again; ordinary stop retains its three-second escalation.

Native input tests use the fake CLI's opt-in `FAKE_AGENT_SESSION_FILES=1` identity/persistence mode; ordinary golden replay remains byte-for-byte unchanged. `[hung]` emits its first turn frame but never completes or acknowledges interrupt, providing a real-child watchdog test without network or credentials.

## Arbiter (not GUI launch configuration)

Claude arbiter argv contract:

```text
claude -p --output-format json --no-session-persistence --tools "" --strict-mcp-config --safe-mode --system-prompt <systemPrompt>
```

Run in an `os.tmpdir()`-based `mkdtemp`, not under userData/home, and with no Dark Mechanicus grant. `src/main/magos/arbiterLaunch.ts` builds this argv without filesystem/process side effects; its tests assert `--safe-mode`, literal empty tools, cwd forwarding and no request text in argv. The runner owns fresh empty temp-directory creation, cleanup and request delivery over stdin; builder tests do not prove runner behavior.

O: official Claude **2.1.331** `--help`, provisioned by the orchestrator as recorded above, explicitly lists all three flags. Relevant text, verbatim:

```text
  --no-session-persistence              Don't save sessions to disk; they can't
                                        be resumed (only works with --print)
  --safe-mode                           Start with all customizations
                                        (CLAUDE.md, skills, installed plugins,
                                        hooks, MCP servers, custom commands and
                                        agents, output styles, workflows, custom
                                        themes, keybindings, and more) disabled
                                        — useful for troubleshooting a broken
                                        configuration. Admin-managed (policy)
                                        settings and the hooks of managed
                                        plugins still apply. Auth, model
                                        selection, built-in tools and plugins,
                                        and permissions work normally. Sets
                                        CLAUDE_CODE_SAFE_MODE=1.
  --tools <tools...>                    Built-in tools to make available: "" for
                                        none, "default" for the default set, or
                                        tool names (e.g. "Bash,Edit,Read")
```

This observes flag availability and its documented promise, **not complete runtime isolation**. In particular, admin-managed policy settings and managed-plugin hooks still apply; auth, model selection, built-in tools/plugins and permissions remain normal. User CLAUDE.md, ancestor context, hooks and plugins make an empty cwd alone insufficient, so retain `--safe-mode` and `--tools ""` together and never pass a grant. Arbiter launch/policy consumers must preserve the managed-policy caveat rather than claim this flag disables every possible hook or tool source.

Single result JSON envelope O: `type:'result',subtype:'success',is_error:boolean,result:string,session_id:string` (SDK excerpts `sdk.d.ts:6413-6415,6492-6499,6539-6540`, and CS:1724-1768). I: same envelope under `--output-format json`, rather than stream-json; no live JSON print probe succeeded. `result` contains the arbiter's strict JSON decision text, not a permission envelope. Reject invalid output; never extract an allow from prose.

OMP candidate argv, **disabled pending evidence**:

```text
omp -p --mode text --no-session --no-tools --config <MCP-disabling-overlay>
```

O flags OMPDOC:98-110 and live 18.20.2 help. I stdout is final answer text only. **Not observed:** whether `omp -p --no-tools` loads MCP tools; whether it consumes nonempty stdin; the exact overlay schema that disables both user MCP and imported `~/.claude.json` MCP. `--no-tools` explicitly promises built-ins only, not MCP. Empty stdin observation above establishes neither property. Therefore `s1-arbiterrules` must classify OMP as **`unsupported_kind`** until both behaviors and the MCP-disabling configuration are observed. Do not invent a config key or enable OMP arbitration based on these fixtures. This is the explicit red-team gate, not a waived safety requirement.

### Launch implementation and remaining isolation gate (DM-815)

`arbiterEnv` reuses the terminal environment's case-insensitive layering, but adds neither terminal constants nor the chat's dm environment/launcher. It removes inherited grants, desktop pipes, Skitarii descriptors, `ELECTRON_*`, `NODE_OPTIONS`, `TERM` and `COLORTERM`; Claude disables automatic memory, and OMP retains its existing constants. Windows uses the canonical `windowsAgentProgram`: followed npm shims run as `node.exe <script.js>`, unresolved shell shims are refused with `SHIM_HELP`. POSIX uses the registered executable; no shell is requested.

Source inspection only, against OMP tag `v18.20.2` (GitHub tree `7c49c11aa5bbaf3f418406583096168ad5b8c6dc`):

- [`mcp/settings.ts`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/mcp/settings.ts) declares `mcp.enableProjectConfig`, startup timeout, rendering and notification settings, **not** a global MCP-disable setting. Disabling project config does not establish user/imported MCP isolation.
- [`sdk.ts`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/sdk.ts) exposes `enableMCP?: boolean` in SDK session options and gates discovery with it; this is not an observed CLI `--config` key.
- [`docs/mcp-config.md`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/docs/mcp-config.md) documents imported `~/.claude.json` and profile-independent external configs. Neither an empty MCP server map nor a fresh OMP profile is proof that all sources are disabled.

Decision: the OMP branch is an **inert candidate spec**, requiring a nonempty `ompConfig` path and refusing an absent/empty path. It does not read, generate or certify that file; no configuration key is invented. Its argv is `-p --mode text --no-session --no-tools --no-lsp --no-extensions --no-skills --no-rules --no-context-files --no-title --max-time 60 --system-prompt <systemPrompt> --cwd <tempDir> --config <ompConfig>`, with no explicit extension. The existing terminal setup overlay alone is **not** an MCP-disabling overlay.

No live OMP arbiter may run from this candidate. `s1-arbiterrules` must reject OMP unconditionally as `unsupported_kind` under the current evidence, regardless of any supplied overlay path. The required MCP-disabling overlay and nonempty-stdin behavior remain unobserved; launch unit tests prove argv/env construction only. This gate and runner-owned temp-directory creation remain cross-ticket requirements, not behavior verified by DM-815. Claude's admin-managed-policy caveat above remains binding.

## Translator contract

The mappings below are the normative host decisions (design requirements, not observations). Unknown fields/events are ignored or diagnosed safely, never raw-rendered. Apply deep claim/grant masking to every output string; raw prompt parsing for attempt binding happens first, and only its `at_` id survives. Every row is scoped to the matching thread when known.

| CLI event/source | Host output / rule |
| --- | --- |
| Host-admitted text user turn | Persist `user_message` once; tool_result-bearing user envelopes are not user messages. |
| Claude `system/init` / OMP `ready`, correlated initialization/get_state | `status`/session metadata; no transcript bubble. Replay pending/todos from snapshot, not duplicate init text. |
| Claude text_delta / OMP text_delta | Ephemeral `delta`, keyed by message/block/thread. Final assistant_text replaces its stream, not appended twice. |
| Thinking delta / thinking block | Ephemeral thinking-channel delta; no new persistent ChatItem kind. Never confuse with assistant answer text. |
| Claude assistant text blocks / OMP message_end assistant text | Persist `assistant_text`; retain order and stable block identity. |
| Claude tool_use/input_json_delta/tool_result; OMP toolcall_* and tool_execution_* | `tool_call` start/update/final with same call id. Partial arguments/results are updates, not independent calls. Failed/cancelled result remains visible. |
| Claude Agent/Task tool_use / OMP subagent_lifecycle and subagent_progress | Open/update `thread`; lifecycle completion settles only that thread. Parent result does not finish running background children. |
| Claude foreground Agent/Task `tool_result` | Complete the matching `thread` by `tool_use_id` (the spawning call id): `done` on success, `failed` when `is_error` is true. This is separate from completing its `tool_call`. O: CT:14-25. |
| Claude Agent/Task `tool_use_result.status: "async_launched"` (or `isAsync: true`), with `agentId` | Complete only the launch `tool_call`; keep its `thread` running/background, and correlate `agentId` to the spawning tool id. This is launch acknowledgement, NOT thread completion; the main turn's result must not settle it. O: CT:18-24, 173-180, 196-201. |
| Claude `system/task_notification` | Resolve the thread by `tool_use_id`, or by `task_id` through the recorded agent-id → spawning-tool-id correlation; update that same `thread` to `done` for `completed`, or `failed` for `failed`/`stopped`. Do not finish sibling threads or treat a background launch as this notification. O: CT:20-24, 27-34. |
| Forwarded Claude assistant/user with parent_tool_use_id / OMP correlated get_subagent_messages | Map ordinary text/tool items with that thread's `threadId`; keep tail request → subagent correlation. |
| Nested Claude Agent/Task tool_use | New `thread` whose `threadId` is the enclosing worker. OMP parent unknown: leave unset, never infer from labels. |
| Thread label source | `description`, else `subagent_type` (OMP agent fallback), else `Subagent`; never prompt/task text. Callsign validation is main's responsibility. |
| Binding source | Claude raw `input.prompt`, OMP raw `task`, before masking; extract exactly one valid fake/real claim token's `at_` id and store only thread → attemptId. Claim binding wins over model label. |
| Claude can_use_tool except AskUserQuestion / recognized OMP select approval | Persist `approval_request` plus ephemeral `pending`; retain exact answer correlation. |
| Claude AskUserQuestion / OMP ask, form, nonapproval select, confirm, input, editor | Ephemeral question `pending`; keep held until person's answer. Never auto-deny or silently drop. |
| Host permission answer | Persist `approval_decision`; send vendor encoding. Chat-wide grants only from offered suggestion/option. |
| OMP cancel.targetId / Claude control cancellation | Remove that pending request; do not synthesize approval. |
| Successful TodoWrite / TaskCreate / TaskUpdate; successful OMP todo details.phases; get_state.todoPhases | Ephemeral per-thread `todos` event + snapshot; successful todo calls hidden. Unknown TaskUpdate id doesn't create a todo. Inferred payload shapes are explicitly documented above. |
| Failed todo call | Ordinary failed `tool_call`; leave prior todos intact. |
| OMP todo_auto_clear | Empty `todos` event; renderer owns lingering display rule. |
| Claude Edit/Write/MultiEdit.file_path, NotebookEdit.notebook_path; OMP edit/write.path | Changes path values retained verbatim after masking; no path normalization or invented shell path extraction. |
| Claude queued_turn_count / OMP queue_update | Ephemeral `queued`; no completed user turn fabricated. |
| Claude result / OMP prompt_result completed | `status:idle` for main turn; keep outstanding worker state. No duplicate assistant_text from result.result. |
| Locally requested interrupt + matching completion / OMP aborted final | Persist `turn_stopped`, settle streaming and pending appropriately; not provider error. |
| Failed result, command refusal, extension error, provider error, masked process stderr/exit | Persist `error` at the proper scope, deduplicating the same terminal failure; `status` reports lifecycle. |
| OMP notify/setStatus/setWidget/setTitle/set_editor_text/open_url; compaction/retry/config/command updates | Sanitized ephemeral state/notice where supported; no auto-opening URL, no forged approval, no raw payload crosses IPC. |
| rpc_chunk | Transport reassembly before translation; never a ChatItem or partial JSON delta. |
