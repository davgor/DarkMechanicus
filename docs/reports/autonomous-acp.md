# Autonomous over ACP: what the installed a8s does

Recorded on 2026-10-29 (US Central) against the installed Autonomous, for the sprint 2 Autonomous adapter (ticket DM-253). The file-write runs under Permissions were added on 2026-10-30 (ticket DM-281). The adapter built from it is `src/main/agents/adapters/autonomous.ts` (ticket DM-259). The sanitized wire recording is `src/main/agents/adapters/__mocks__/autonomousRecordings.ts`.

## How it was run

- `a8s` is `~/.local/bin/a8s`, a `#!/bin/sh` launcher into the managed install. `a8s --version` printed `Autonomous 0.79.0 · darwin-arm64 · OMP 18.11.2`. The ticket expected 0.77.0; the install has since updated itself. The profile is personal (`a8s status`: `Profile  ~/.config/a8s/profile.json (personal)`).
- The scratch folder was a fresh `mktemp -d` directory with `git init` and one empty commit, outside every repository. A throwaway Node script, also in a temp folder outside every repository, spawned `a8s` with `shell: false` and spoke newline-delimited JSON-RPC on stdio. It timed out each request after 120 s and the whole run after 8 min, and killed the child (SIGTERM, then SIGKILL) at the end. It was deleted afterwards, together with the scratch folder.
- Three processes ran, each with the same `initialize` that `cursorSession.ts` sends (protocol 1, `fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false`) and the `authenticate` it listed:
  1. `a8s start <scratch> --mode acp --approval-mode always-ask`: `session/new`, turn 1 ("run `pwd`, then create hello.txt"), turn 2 (`sleep 60`, cancelled).
  2. The same argv: `session/load` of process 1's session id, `session/set_config_option` to Haiku, one turn (`pwd`, rejected).
  3. `a8s start <scratch> --mode acp` (no `--approval-mode`): `session/new` and one turn (`pwd`, rejected).
- Four model turns in all, on the person's Claude subscription. Nothing was signed out or changed.
- Nothing was written to stderr in any process. Each process took about 11 s to answer `initialize`, and exited with code 1 when SIGTERM ended it.
- **DM-281** (2026-10-30, same install and profile): six more processes, numbered 1 to 6 under Permissions. Each ran in its own fresh scratch Git repository (one empty commit) in a temp folder outside every repository, from a throwaway Node client like DM-253's that spawned `a8s` in its own process group and killed the group (SIGTERM, then SIGKILL) at the end. Client and scratch folders were deleted afterwards. Each process ran `initialize` with the capabilities its run lists, `authenticate`, `session/new` and one turn with DM-253's turn-1 prompt: "Run the shell command `pwd`. Then create a file named hello.txt containing "hi" in the current folder. Use one tool call for each step. Be brief." The client allowed every `session/request_permission` (`allow_once`), wrote the file itself for any `fs/write_text_file` (answering `{}`), would have read it for `fs/read_text_file` (none came), and answered `elicitation/create` as each run says. The argv was `a8s start <scratch> --mode acp [--approval-mode <mode>] --model anthropic/claude-haiku-5-5 --thinking off`. The last two flags only kept each turn cheap: `usage_update` put the six turns at $0.0008 to $0.0053 each. Nothing was written to stderr. `initialize` took 11 to 17 s, and each process exited with code 1 when SIGTERM ended it.

## Findings

### `initialize`

The same in all three processes, and in DM-281's six whatever capabilities the client declared:

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "Autonomous", "title": "Autonomous", "version": "18.11.2" },
  "authMethods": [
    { "id": "agent", "name": "Use existing local credentials",
      "description": "Authenticate via the provider keys/OAuth state already configured under ~/.omp." }
  ],
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} }
  }
}
```

- `agentInfo.version` is the bundled OMP version (18.11.2), not the Autonomous version (0.79.0).
- One auth method, `agent`. `authenticate {methodId: "agent"}` answered `{}` at once while signed in. The adapter should send `authenticate` with the listed id rather than a hard-coded one.
- `loadSession: true`. `promptCapabilities` has no `audio`. `sessionCapabilities` advertises `list`, `fork`, `resume` and `close`; none of those methods was called (**unverified**).

### `session/new`

Result: `sessionId` (a UUIDv7 string), `configOptions` and `modes`. There is no `models` field.

- `configOptions`:
  - `mode` (category `mode`, select): `default` ("Standard ACP headless mode") and `plan` ("Read-only planning mode that drafts a plan to a markdown file before any code changes"); current `default`.
  - `model` (category `model`, select): `anthropic/claude-fable-5-1`, `anthropic/claude-haiku-5-5`, `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5`; current `anthropic/claude-opus-5-5` (the profile default `a8s status` shows). Each option's `name` is the display name ("Claude Opus 5.5") and its `description` repeats the id.
  - `thinking` (category `thought_level`, select): `off`, `auto`, `low`, `medium`, `high`, `xhigh`, `max`; current `xhigh`.
- `modes`: `{ currentModeId: "default", availableModes: [default, plan] }`, the same two as the `mode` config option.
- Before the `session/new` result arrives, a8s sends a `session/update` (`agent_message_chunk`) for the new session id: "Hivemind is Off. Anonymous usage metrics are separate. Enable sharing in a terminal before the first turn." The client does not know the id yet when it arrives. It arrives the same way during `session/load`, before the replayed history.

### Updates

`session/update` kinds seen: `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk` (only in `session/load` replay), `tool_call`, `tool_call_update`, `available_commands_update`, `session_info_update`, `usage_update`, `config_option_update` (after `session/set_config_option`), and `plan` (DM-281 run 1 only, see below). `current_mode_update` was not seen.

- Chunks carry a `messageId`; thought and answer chunks of one reply share it.
- The first turn in each process starts with `available_commands_update` (60 slash commands: `fast`, `usage`, `compact`, `model`, `approval-mode`, skills as `skill:<name>`, ...) and `session_info_update {updatedAt}`. The second turn in process 1 did not repeat them.
- Each turn ends with `usage_update {size, used, cost: {amount, currency: "USD"}}` and `session_info_update`, then the `session/prompt` result `{stopReason, usage: {inputTokens, outputTokens, totalTokens, cachedReadTokens, cachedWriteTokens}}`.
- A shell call is `tool_call` (`kind: "execute"`, title `$ pwd`, `rawInput.command`), then `tool_call_update`s with `status` `in_progress`, then `completed` or `failed`. The output appears in both `rawOutput.content` and `content`. The `tool_call` arrives only *after* the permission answer.
- A file write is `tool_call` (`kind: "edit"`, `status: "pending"`, a title in the model's words such as `Creating hello.txt` or `Creating hello.txt with "hi"`, `rawInput: {path, content}`, `locations: [{path}]` with the absolute path). Unlike a shell call, the write's `tool_call` arrives *before* any prompt for it. When the write runs, `tool_call_update` `in_progress` ("Writing 2 bytes to hello.txt...", `rawOutput.details.resolvedPath`, `locations`) and `completed` ("Successfully wrote 2 bytes to hello.txt") follow. When it is refused, a single `tool_call_update` `failed` follows (see Permissions).
- In DM-281 run 1 the model (Haiku) also used its todo tool: `tool_call` with `kind: "think"` (for example `rawInput: {op: "init", list: [...]}`), completed without a prompt, followed by `plan` updates `{entries: [{content, priority: "medium", status}]}`. No other run did.

### Permissions

A `session/request_permission` request with the agent's own request ids (0, 1, ... per process):

```json
{
  "sessionId": "<id>",
  "toolCall": {
    "toolCallId": "toolu_...", "title": "pwd", "kind": "execute", "status": "pending",
    "rawInput": { "command": "pwd" },
    "content": [{ "type": "content", "content": { "type": "text", "text": "$ pwd" } }],
    "locations": []
  },
  "options": [
    { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
    { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" },
    { "optionId": "reject_always", "name": "Always reject", "kind": "reject_always" }
  ]
}
```

- Option ids equal their kinds and use underscores (`allow_once`), unlike Cursor's `allow-once`.
- `allow_once`: the command ran. `reject_once`: `tool_call_update` `failed` with "Tool call rejected by user (bash)", and the turn ended `end_turn`. `{outcome: "cancelled"}`: `failed` with "Permission request cancelled".
- **Which tools use `session/request_permission`:** only shell commands (`kind: "execute"`) did in any run. A file write never did. It asks with `elicitation/create` instead, and only when the client supports it (next section).

#### Why the write was refused without a request

**Cause, from the runs below:** a8s asks about a file write (its `write` tool) with an ACP form elicitation, `elicitation/create`, not `session/request_permission`. It sends that request only when the client's `initialize` declared `clientCapabilities.elicitation.form`. DM-253's client declared no elicitation support (Cursor's capabilities), so a8s could not ask. It counts the unaskable prompt as a denial and fails the call with "Tool call denied by user: write", the same failure a declined elicitation gives (run 6). The `fs` capabilities play no part: they only decide who writes the file once it is allowed.

Each run: one `pwd` (allowed) and one `hello.txt` write, as described under How it was run. "Prompt for the write" is the request a8s sent before the write ran or failed.

| Run | `--approval-mode` | Client `fs` read / write | Client `elicitation.form` | Prompt for `pwd` | Prompt for the write | `hello.txt` created | ACP messages that carried the write, in order |
|---|---|---|---|---|---|---|---|
| DM-253 | `always-ask` | false / false | not declared | `session/request_permission` | **none** | no | `tool_call` pending; `tool_call_update` failed "Tool call denied by user: write" |
| 1 | `always-ask` | true / true | not declared | `session/request_permission` | **none** | no | as DM-253; no `fs/*` request |
| 2 | `write` | true / true | not declared | `session/request_permission` | **none** (not needed) | yes | `tool_call` pending; `tool_call_update` in_progress; `fs/write_text_file` (the client wrote the file); `tool_call_update` completed |
| 3 | none | true / true | not declared | `session/request_permission` | **none** | no | as run 1 |
| 4 | `always-ask` | true / true | `{}`; answered Approve | `session/request_permission` | `elicitation/create` | yes | `tool_call` pending; `elicitation/create`; `tool_call_update` in_progress; `fs/write_text_file` (the client wrote the file); `tool_call_update` completed |
| 5 | `always-ask` | false / false | `{}`; answered Approve | `session/request_permission` | `elicitation/create` | yes | `tool_call` pending; `elicitation/create`; `tool_call_update` in_progress; `tool_call_update` completed (a8s wrote the file) |
| 6 | `always-ask` | false / false | `{}`; answered decline | `session/request_permission` | `elicitation/create` | no | `tool_call` pending; `elicitation/create`; `tool_call_update` failed "Tool call denied by user: write" |

- **Run 1 against run 4:** same flags and `fs` capabilities, and `elicitation.form` is the only difference. It is what made a8s ask about the write. **Run 4 against run 5:** with `fs.writeTextFile: true` a8s hands the allowed write to the client as `fs/write_text_file`. Without it, a8s writes the file itself.
- **Run 2:** `--approval-mode write` lets a write run without asking at all, while `pwd` still asked.
- **Run 3:** without `--approval-mode` the write was refused exactly as under `always-ask`, so this profile's default also prompts for writes. Where that default comes from (a8s's defaults or the person's own settings) was not checked.
- **The source agrees.** These files are in the OMP 18.11.2 `pi-coding-agent` package bundled in the a8s install:
  - `session/acp-permission-gate.ts` gates only `bash`, `delete` and `move` with `session/request_permission`, plus `edit` when the edit deletes or moves a file.
  - Every other tool that needs approval goes through `tools/approval.ts`. In ACP that is a `select` of `["Approve", "Deny"]`.
  - `modes/acp/acp-agent.ts` implements that `select` as `elicitation/create`, and returns no answer when `clientCapabilities.elicitation.form` is absent.
  - `extensibility/extensions/wrapper.ts` then throws "Tool call denied by user: <tool>".
  - `always-ask` approves only read-tier tools without asking. `write` also approves write-tier tools, and `yolo` approves everything.

The request, from run 5 (session id sanitized):

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "<id>",
    "message": "Allow tool: write\nPath: hello.txt\nContent:\nhi",
    "requestedSchema": {
      "type": "object",
      "properties": { "value": { "type": "string", "enum": ["Approve", "Deny"] } },
      "required": ["value"]
    }
  }
}
```

- It came right after the write's `tool_call` (pending), and it shares the agent's request-id counter with `session/request_permission`: `pwd`'s request was 0 and the write's was 1. It carries no `toolCallId`, so the link to the tool call is only the order and the session id. Its `message` is the prompt text, with the file's content in it.
- `{action: "accept", content: {value: "Approve"}}` let the write run: `in_progress`, then `completed`. `{action: "decline"}` failed it with "Tool call denied by user: write", and the model said it would not retry. Not tried (**unverified**): `accept` with `Deny`, `{action: "cancel"}`, an error reply. Per the source, anything but `accept` with `Approve` denies.
- The form offers no "always allow", unlike `session/request_permission`. [INFERENCE] Each write asks again. Only one write per session was tried.
- With `fs.writeTextFile: true` (runs 2 and 4), the allowed write arrived as `fs/write_text_file {sessionId, path, content}`. The `path` is absolute, in realpath form (`/private/tmp/...`), and the request comes between the `in_progress` and `completed` updates. The client answered `{}` after writing the file. With `fs.readTextFile: true`, no `fs/read_text_file` arrived: the file was new.

### Cancel

`session/cancel` was sent while the `sleep 60` permission request was open, then that request was answered `{outcome: "cancelled"}`. a8s sent the `tool_call` (pending) and answered the `session/prompt` with `stopReason: "cancelled"` within 2 ms. The command never ran. Cancelling while a command is already running was not tried (**unverified**).

### `session/load`

In a new process, `session/load {sessionId, cwd, mcpServers: []}` of process 1's id worked. Before its result, a8s replayed the whole history as updates: the Hivemind notice, each user prompt as `user_message_chunk`, the tool calls with their final status, and the thought and answer chunks. Permission requests are not replayed. The result is `{configOptions, modes}` with no `sessionId`. A turn after the load had the earlier context: the agent's answer referred to the cancelled `sleep 60` and the denied write. Loading an unknown id was not tried, so the not-found error shape is **unverified**.

### Folder

`pwd` printed `/private/var/folders/.../T/tmp.XXXXXXXXXX`. The scratch path passed as `[DIR]` and `cwd` was `/var/folders/.../T/tmp.XXXXXXXXXX`. They are the same folder: macOS `/var` is a symlink to `/private/var`, and `pwd -P` in the scratch folder printed the `/private` form. The process works in the requested folder but reports its realpath, including in `locations[].path`. The adapter should compare folders by realpath.

### Approvals without `--approval-mode`

It asks. With `a8s start <scratch> --mode acp` and no `--approval-mode`, `pwd` raised the same `session/request_permission` with the same four options. A write behaved as under `always-ask` (DM-281 run 3): refused without a request when the client declares no `elicitation.form`. The adapter should still pass `--approval-mode always-ask` so the behaviour does not depend on the profile's default.

### Models

- **Listing without a chat:** no CLI command lists them. `a8s omp --help` takes only `--version`, `--mode`, `--cwd`, `--resume`, `--continue`, `--model`, `--provider`, `--thinking`, `--approval-mode`, `--append-system-prompt`, `--config`, `--tools` and `--profile`, and says "Other OMP commands and flags are refused". `a8s omp --list-models` exited 2 with `Unknown option '--list-models'. See a8s omp --help for the OMP flags it takes.` `a8s status` prints only the default (`Default model  anthropic/claude-opus-5-5 on your Claude subscription`). The list the profile allows comes from ACP: `initialize` plus `session/new`, which return `configOptions[id=model].options` with no model turn. That `session/new` opens a session that a8s records, and `session/close` does not remove it (DM-306, below).
- **Switching:** an ACP method works. `session/set_config_option {sessionId, configId: "model", value: "anthropic/claude-haiku-5-5"}` on the loaded session answered `{configOptions}` with `model.currentValue` Haiku, after a `config_option_update` notification. The next turn ran on the new model: `usage_update.size` went from 1,000,000 (Opus) to 100,000. `thinking` and `mode` are config options of the same kind but were not switched (**unverified**), and neither was `session/set_mode`. A `--model` relaunch plus `session/load` was not tried (**unverified**). `session/load` reported the model the session was created with (`anthropic/claude-opus-5-5`) as current.

#### Does `session/close` remove the listing session? (DM-306)

**No.** Recorded on 2026-10-30 (US Central, 23:48) with the same a8s 0.79.0 and personal profile. One model listing was run by a throwaway Node client in `/tmp` (deleted afterwards) that followed `readModelsIn` in `autonomous.ts`: a fresh `mkdtemp` folder (not a Git repository), `a8s start <folder> --mode acp --approval-mode always-ask` spawned with `shell: false` in its own process group, `initialize` (protocol 1, no fs or terminal capabilities), `authenticate {methodId: "agent"}` (answered `{}`), `session/new` (4 model options), `session/close` (answered `{}`), then SIGTERM to the group and removal of the folder. No prompt was sent. The whole run took about 5 s.

`a8s sessions --help` documents only `[list] [--json]` for listing, plus `show`, `search`, `changes`, `export`, `verify` and `sent`, each taking `--capture-dir PATH`. There is no flag to filter by folder or to delete a session. Recordings live under `--capture-dir`, default `<home>/.local/state/a8s/captures` (the new one was `native-omp/sessions/<timestamp>_<acp session id>.jsonl`); they were only listed, never edited or deleted.

- **Before** (`a8s sessions --json`): 17 sessions, none in a `DM-306-list-*` folder (all 17 are the person's own sessions in other folders, not shown).
- **After:** 18 sessions. The one new row, from `a8s sessions` (the other 17 unchanged, not shown):

  ```
  a8d534df  today 23:48  DM-306-list-6mt8Av         claude-opus-5-5
  ```

  Its `--json` row, trimmed: `cwd` `/private/var/folders/<tmp>/T/DM-306-list-6mt8Av` (already deleted), `events: 14`, `endedEarly: false`, `coverage.state: "incomplete"` with the gaps "Personal session: recorded on this machine only and not delivered to the company." and "Native host stopped: sigterm". The recording file is named after the ACP session id `session/new` returned; the a8s session id (`a8d534df-…`) differs from it.
- `a8s sessions show a8d534df` printed "Nothing was said in this session." and "Usage export: not exported: it closed before any prompt or model call."

So every listing leaves one empty session in the person's `a8s sessions` list, with the temp folder name, plus a recording of about 14 events. `session/close` ends the session but does not remove its record. The app lists once per executable per app run (`listings` in `autonomous.ts`), so it is one stray row per app start that opens an Autonomous chat, not one per chat.

**Proposed fix (not implemented):**

1. **Don't open a session just to list.** Take the model options from the chat's own `session/new`: the chat already gets `configOptions[id=model]` there, so the picker can fill from the first real session and cache that per executable. Before the first chat, show only the profile default (`a8s status` prints `Default model`) or the last cached list (persisted in the app's settings), and refresh it from each chat's `session/new`. This removes the stray session entirely.
2. If a list is needed before any chat, keep today's one listing per app run but persist its result across runs, so the stray session appears once per a8s update rather than once per app start (re-list when `a8s --version` changes).
3. Ask a8s upstream for either a listing that opens no session (e.g. `a8s omp --list-models` or a `models` field on `initialize`), or for `session/close` on a session with no prompt to discard its recording. a8s already knows the session is empty ("closed before any prompt or model call").

Option 1 is the recommended one: no upstream change and no stray records. Deleting the record from the app is not proposed: a8s offers no delete command, and the app must not edit a8s's recordings.

### Sign-in

- **Signed in, model:** `a8s doctor` (about 3 s) has a `Model route` line, `✓ Model route  Claude subscription · anthropic/claude-opus-5-5 · signed in`, and ends `0 problems, 3 warnings.` with exit 0. Failed checks print `fix:` lines. It also checks company Okta (`✓ Okta  signed in as <email>`), `gh` and other tools, and prints local paths and the account's email, so its output must be masked before it is shown or logged.
- `a8s status` (exit 0) shows the profile, gateway, `Model key  none (optional) · a8s login --key adds Bifrost models`, `Default model  anthropic/claude-opus-5-5 on your Claude subscription`, captures and version. It does not say signed in or signed out.
- `a8s doctor --readiness --cwd <dir>` checks Node, Bun, git, Python, the workspace, Semgrep and the Factory CLI "without sign-in", and ended `Installation readiness passed.` with exit 0. It says nothing about sign-in. It is the check for "installed and usable in this folder".
- **Signing in:** per `a8s --help`, the model sign-in is `a8s init [--force] [--yes]` ("Choose Claude or Codex and save an authenticated default") or `/login` inside a session. `a8s setup` opens onboarding. `a8s login` with no flag is the **company Okta** sign-in and `a8s login --key` stores the optional Bifrost key; neither is the model sign-in. `a8s init --help` and `a8s login --help` both printed the general `a8s --help` text and exited 0; neither was run without `--help`.
- **Signed out:** recorded with an isolated profile (DM-307, below). With a personal profile, `a8s doctor` prints `✗ Model route             Claude subscription is not ready` and `fix: a8s init --force`, and exits 1. With no profile it prints `! Model route             not signed in to Claude, so sessions open without a default model` (a warning) and `fix: run /login in a session and choose Anthropic, or a8s init --force`, and exits 1 because of the failed `Profile` check. `a8s status` (exit 0) says `Default model  none until you sign in to Claude: /login in a session, choose Anthropic`.

### Signed out

**How it was run** (DM-307, 2026-10-30, same install). The person's own sign-ins were never touched: no login, logout, `init`, `auth` or credential command ran in any environment, and only a profile that had never signed in was observed.

- **Isolation.** A temporary HOME under `/tmp` with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TMPDIR` and `PI_CODING_AGENT_DIR` inside it, started through `env -i` with only those, HOME, PATH, USER, LOGNAME, TERM, NO_COLOR and the locale, so no `ANTHROPIC_*`, `ONEBRIEF_*`, `OMP_PROFILE`/`PI_PROFILE` or other credential variable reached a8s. The shell had no credential variable set either.
- **Keychain.** The model sign-in is OMP's own stored login, a SQLite store at `<agent dir>/agent.db` under the HOME (`~/.omp/agent`), read through its `AuthStorage`. Neither OMP 18.11.2's sources nor a8s's read it from the Keychain: a8s calls `/usr/bin/security` only for the optional Bifrost key (service `onebrief`, which the person's `a8s status` shows as none), and the commands run here could at most look that entry up, never write it. So a temporary HOME isolates the model sign-in.
- **Proof.** `a8s doctor` in that environment printed every profile, capture, workspace and tool path under the temporary HOME (only the install's own paths, `~/.local/opt/a8s`, are outside it), and its `Model route`, `Okta`, `gh`, `Factory` and `Multiplayer` lines all said not signed in, where the person's own `a8s doctor` says signed in to the model and Okta.
- **Profiles.** Two: a copy of the person's personal `profile.json` (schema 1, `subscriptionProvider: anthropic`, no secret in it), the case of someone who set a8s up and is signed out of the model; and none at all, someone who never ran `a8s init`.
- **ACP.** A throwaway Node client under `/tmp`, like DM-281's, spawned `a8s start <scratch repo> --mode acp --approval-mode always-ask` in its own process group in a scratch Git repository (one empty commit) under the temporary HOME, with this adapter's `initialize` (`fs` false, `terminal` false, `elicitation.form`). It would then have sent `authenticate`, `session/new` and `session/prompt` "ok". Three launches: the personal profile twice (the second with `--model anthropic/claude-haiku-5-5`), and no profile. The client, the temporary HOME and the scratch repository were deleted afterwards. The sanitized outputs are `src/main/agents/adapters/__mocks__/autonomousSignedOut.ts`.

**What a8s does with no model sign-in:** it answers no ACP request. It stops at launch, before answering `initialize`, writes one sentence on stderr, and exits. Nothing is written to stdout, so there is no `authenticate`, `session/new` or `session/prompt` error, and no `authMethods` to compare.

| Launch | Exit | After | stderr, last line |
|---|---|---|---|
| Personal profile, first launch | 1 | 1.5 s | `Autonomous stopped: Your selected subscription is signed out. Run a8s init --force; no other billing route was selected.` |
| Personal profile, `--model anthropic/claude-haiku-5-5` | 1 | 7 s | the same |
| No profile | 2 | 0.8 s | `Profile not found: <home>/.config/a8s/profile.json. Run a8s init to create it, or pass --profile FILE.` |

- The first launch of a profile writes a one-time metrics notice (22 lines, "What Autonomous collects · please help us improve!") on stderr before the stop; the next launch wrote `Checking for restricted repositories…` and `✓ No restricted repositories · 1 folder · 1 repository · 1s` instead. Either way the stop is the last line.
- Per the source (`dist/omp/host.js`), the subscription stop comes from the launch-default check: a personal profile whose `subscriptionProvider` default has no OAuth sign-in stops there. Its other signed-out `Model route` wordings in `dist/omp/route-step.js` also say "is not ready" ("Codex subscription is not ready", "<model> is not ready"); they were not observed.
- **What the app makes of it:** the connection sees the process end as `Autonomous stopped: exit code 1: <last 500 characters of stderr>` (`acpProcess.ts`). The Autonomous flavor reads either sentence at its end as a missing sign-in and reports it as one `auth_required` item with a8s's sentence; both are fixed by `a8s init`, which is what the app runs to sign Autonomous in. `agentAuth.ts` reads a `Model route` line that says "is not ready" or "not signed in" as signed out.
- Not observed: a process that was signed in when it started and loses its sign-in mid-session (that needs the person's sign-in removed), and a signed-in profile whose OAuth token was refused by Anthropic.

## For the adapter

- **Launch argv** (spawn with `shell: false`, `cwd` the chat's folder):
  `[<a8s path>, "start", <folder>, "--mode", "acp", "--approval-mode", "always-ask"]`.
  Optional launch flags, from `a8s --help`: `--model <PROVIDER/ID>`, `--thinking <LEVEL>`, `--append-system-prompt <TEXT>`. In DM-281, `--model anthropic/claude-haiku-5-5 --thinking off` showed up in `session/new` as the current `model` and `thinking` values. ACP mode needs a personal profile, and `resume` does not take `--mode acp`: the app reopens sessions with `session/load`. Do not launch with `--approval-mode write` or `yolo`: a write then runs without asking (run 2).
- **Client capabilities** (`initialize` params): `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false, elicitation: {form: {}}}, clientInfo}`. That is Cursor's set plus `elicitation: {form: {}}`, and it is what run 5 sent (recorded as `AUTONOMOUS_RECORDINGS.writeProcess`). With this `initialize` and the launch argv above, a file write asks for permission with `elicitation/create` and succeeds once allowed, and a shell command asks with `session/request_permission` and runs once allowed. Without `elicitation.form`, every write is refused unasked (runs 1 and 3). Keep `fs` false so a8s writes the file itself. With `fs.writeTextFile: true` it also works (run 4), but the adapter must then do the write when `fs/write_text_file` arrives.
- **Handshake:** `initialize` with the capabilities above, then `authenticate` with `authMethods[0].id` (`agent`) only when it is listed, then `session/new` or `session/load` with `{cwd, mcpServers: []}`. Tolerate `session/update` for a session id before `session/new` answers, and suppress the replay during `session/load` as `cursorSession.ts` does.
- **Permission prompts:** handle two agent requests.
  - `session/request_permission` (shell commands): answer with one of its four `optionId`s.
  - `elicitation/create` with `mode: "form"` and one `value` field whose `enum` is `["Approve", "Deny"]` (file writes). Show it as an allow/deny prompt with its `message` as the text. Tie it to the session's latest pending `tool_call`, since it carries no `toolCallId`. Allow: `{action: "accept", content: {value: "Approve"}}`. Deny: `{action: "decline"}`.
  - Both requests take ids from the same counter.
  - [INFERENCE from the source] An `elicitation/create` of another shape (skills and extensions can also ask through it) should be answered `{action: "decline"}`, which a8s reads as no answer.
- **Models:** list from `configOptions` (`id: "model"`) on `session/new`/`session/load`, and switch with `session/set_config_option {configId: "model", value}`. There is no CLI listing.
- **Status and login commands:** use `a8s doctor` and its `Model route` line: "signed in" on a passed check is signed in, and "is not ready" or "not signed in" is signed out (both recorded, see Signed out). Its exit code says nothing about the model: it is 1 for any failed check. Use `a8s doctor --readiness --cwd <folder>` for installed-and-ready. Send people to `a8s init` (or `/login` in a session) to sign in to a model, not to `a8s login`.
- **Signed out:** expect no ACP error. a8s exits before answering `initialize`, and the last stderr line says why: `Autonomous stopped: Your selected subscription is signed out. Run a8s init --force; …`, or `Profile not found: <path>. Run a8s init to create it, …`. Report either as a sign-in to do (`a8s init`), with that sentence, and start a new process for the next message.
- **Find probe:** run `<a8s path> --version`. It prints one line on stdout and exits 0:
  `Autonomous <version> · <os>-<arch> · OMP <omp version>`, for example `Autonomous 0.79.0 · darwin-arm64 · OMP 18.11.2`. The separators are U+00B7 MIDDLE DOT with one space on each side. A matching pattern: `^Autonomous (\S+) · (\S+) · OMP (\S+)$`. Use the first group as the CLI version, not `agentInfo.version` (which is OMP's). `a8s omp --version` prints `omp/18.11.2`.

## Not verified

- For writes: `elicitation/create` answered `accept` with `Deny`, `{action: "cancel"}` or an error; `session/cancel` while one is open; a second write in the same session (the form has no "always allow"); the elicitation `message` for long file content.
- How `edit` (changing an existing file), `delete` and `move` ask. Per the source: `delete`, `move`, and an `edit` that deletes or moves a file use `session/request_permission`, and other edits use `elicitation/create`. None was run.
- Where the profile's default approval mode (no `--approval-mode`) comes from.
- A sign-in lost while a process runs, and a stored OAuth token Anthropic refuses: what a8s answers then (an ACP error, a stop or assistant text). Only a profile that never signed in was observed (Signed out).
- Switching models with a `--model` relaunch plus `session/load`; switching `thinking` or `mode`; `session/set_mode`.
- `session/list`, `session/fork`, `session/resume`; the error from `session/load` of an unknown id. `session/close` answered `{}` in DM-259's live handshake (no prompt, a non-Git temp folder, whose `session/new` also worked); whether it removes the session from a8s's records was not checked.
- Cancelling while a command is already running, rather than at its permission prompt.
