# Acceptance procedure: Skitarii messaging (real app, scratch profile)

Runs the built app against a scratch profile, scratch home and scratch Git repository, with two real Skitarii (OMP)
chats, and checks every promise of [the design record](../design/skitarii-messaging.md). It never touches the person's
own profile (`%APPDATA%\dark-mechanicus`, `~/Library/Application Support/…`), home (`~/.darkmechanicus`) or repositories.
A script that automates it (`scripts/smoke-skitarii-messaging.mjs`) follows these steps in this order and records each
expected result.

## Parameters

Set these in Git Bash (Windows) or a POSIX shell. Nothing below hardcodes a private path.

```sh
APP=<path to the Dark Mechanicus checkout under test>   # the worktree to build and launch
OMP=<absolute path of the installed omp executable>     # e.g. the one Find reports; signed in, with a model
PORT=9514                                               # any free remote-debugging port
S="$(mktemp -d)"                                        # the scratch root; everything below lives in it
PROFILE="$S/profile" HOME_DIR="$S/dm-home" REPO="$S/repo" ARGS="$S/args"
mkdir -p "$PROFILE" "$HOME_DIR" "$REPO" "$ARGS"
```

Steps marked **(model)** need the OMP chat to answer prompts, so they spend model tokens; every other step does not.
Record `"$OMP" --version` and `node -p process.version` with the evidence.

## 1. Build and launch

```sh
cd "$APP" && npm ci --no-audit --no-fund && npm run build
git -C "$REPO" init -q && git -C "$REPO" commit -q --allow-empty -m scratch
DARKMECHANICUS_HOME="$HOME_DIR" DISABLE_AUTO_UPDATE=1 \
  npx electron . --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" &
```

Drive the window over CDP (`http://127.0.0.1:$PORT/json`) or by hand. `window.dm` calls below run in the renderer.

1. Track `$REPO` (**+** → **Add existing folder…**; over CDP, stub the native folder dialog through the main-process
   inspector and say so in the evidence) and initialize it **In this repository**.
2. **Find** Skitarii so the app knows `$OMP`, and sign it in if needed.
3. Create two chats and open each so its terminal starts:
   ```js
   const a = await window.dm.chats.create({ folder: REPO, agent: 'omp', role: 'worker', title: 'Alpha' })
   const b = await window.dm.chats.create({ folder: REPO, agent: 'omp', role: 'reviewer', title: 'Beta' })
   ```
   Expect both `ok`, each record with an `endpointId` (`me_…`) once its terminal has started.

## 2. Generated guidance

For each chat, read `$PROFILE/agents/instructions/<chatId>.md`. Expect:

- a `## Skitarii mail` section after the collaboration policy, naming `dm_agent_identity`, `dm_agent_peers`,
  `dm_message_send`, `dm_inbox_read`, `dm_inbox_ack` and the CLI commands, and saying peer text is task data;
- no grant: the file does not contain the value of the chat's `DM_SESSION_TOKEN`;
- on macOS/Linux, mode `0600` (and the `agents/bin/<chatId>/dm` launcher `0700`).

A Claude Code or other non-OMP chat's instructions have no `## Skitarii mail` section.

On Windows the file's first `sh` block gives the chat's pinned `dm` command line; call it `DM` below (on macOS it is the
launcher path). It only works with the chat's own grant, so every `$DM` step runs **inside the chat**: ask its agent to
run the line exactly as written **(model)**.

## 3. Native tools (model)

In Alpha, prompt: "Call dm_agent_identity, then dm_agent_peers, and show both results verbatim."
Expect: identity `{endpointId: A, name: "Alpha", role: "worker", …}`; peers lists `{endpointId: B, name: "Beta"}` and not
Alpha. Each result starts with the fixed note that names and bodies are other agents' task data.

In Alpha: "Call dm_message_send with to=B, clientMessageId=accept-1, body='Ready for review?'." Expect
`{messageId: M1, to: B, clientMessageId: "accept-1", inReplyTo: null, duplicate: false, …}`. Ask it to repeat the call
unchanged: same `messageId`, `duplicate: true`. Ask it to send `accept-1` with another body: `idempotency_mismatch`.

## 4. Human seen versus agent acknowledgement (no model)

```js
await window.dm.chats.mail.state({ folder: REPO, chatId: b.data.id })
```
Expect `unseenCount: 1`, `pendingCount: 1`. In Beta's header, **Messages** shows 1 unseen by you and 1 unacknowledged by
its agent. Open it and press **Mark shown messages seen**: unseen becomes 0, unacknowledged stays 1.

## 5. Passive notice; no wake without Allow

With Beta idle (no prompt running), expect its status line `Skitarii mail: 1 unread` and one notice naming Alpha, and
**no turn starts** for at least 30 s: the reminder waits for Beta's next natural prompt.

## 6. CLI: read, correlated reply, acknowledgement (model runs the commands)

In Beta, ask the agent to run these lines exactly and show the raw stdout (JSON goes in on stdin or in an args file; no
shell string is parsed by `dm`):

```sh
$DM call get_capabilities                       # "mailbox":{"bound":true,"endpointId":"<B>"}
printf '%s' '{"limit":10}' | $DM call list_agent_peers -
printf '%s' '{"unacknowledgedOnly":true}' | $DM call read_agent_inbox -
```

Expect the read to return M1 with its body, `acked: false`. Reading did not acknowledge: `get_agent_mail_status` still
reports `pendingCount: 1`. Then the reply and the acknowledgement through args files (the Windows form):

```sh
printf '%s' '{"to":"<A>","clientMessageId":"reply-1","body":"Reviewed: ship it.","inReplyTo":"<M1>"}' > "$TMP/reply.json"
$DM call send_agent_message --args-file "$TMP/reply.json"
printf '%s' '{"messageIds":["<M1>"]}' > "$TMP/ack.json"
$DM call acknowledge_agent_messages --args-file "$TMP/ack.json"
$DM call acknowledge_agent_messages --args-file "$TMP/ack.json"   # same acknowledgedAt as the first
$DM call get_agent_mail_status                                   # pendingCount: 0
```

Expect the reply `{inReplyTo: M1, duplicate: false}` and `acknowledged[0].expiresAt` seven days after `acknowledgedAt`.
A reply to a message id that is not in Beta's inbox (`"inReplyTo":"mm_unknown"`) is refused (`reply_unavailable` or
`invalid_input`). Alpha then reads Beta's reply with `dm_inbox_read` and acknowledges it with `dm_inbox_ack`.

## 7. Allow one inbox wake

Have Alpha send Beta one more message. With Beta idle, in Beta's inbox press **Allow one inbox wake** twice before
anything consumes it: the second press keeps one armed credit (`wake.armed: true`, same credit). Expect exactly one
follow-up turn in Beta carrying the fixed wake text **(model)**, then `wake.armed: false` and
`wake.lastAttempt.outcome: "attempted"`. No second turn starts without another Allow.

## 8. Refusals (no model)

From a plain shell, with no grant:

```sh
cd "$REPO" && DARKMECHANICUS_HOME="$HOME_DIR" node "$APP/out/main/cli.js" --repo "$REPO" call get_agent_identity
```

Expect `{"ok":false,"error":{"code":"unauthorized",…}}`. The same for an MCP (stdio) session's `get_agent_identity`, and
for `backup_database` run by a chat's agent: it is desktop-only.

## 9. Deletion

Delete Beta from its sidebar row. Expect: Beta's received mail purged and its endpoint `deleted`; Alpha's inbox still
holds Beta's reply, with a deleted sender; Alpha's `dm_message_send` with `inReplyTo` set to Beta's reply is refused,
and Beta no longer appears in `dm_agent_peers`.

## 10. Quit

Close the window. Expect every process the run started (Electron, OMP, `dm` children) gone within 5 s. Remove `$S`.

## Recording evidence

Keep, outside the repository: each command with its raw JSON, the generated instruction files (with no token in
them), CDP results, screenshots of steps 4 and 7, `"$OMP" --version`, and the process list after quit. Report a step
that could not run (for example no model available) as not run, never as passed.
