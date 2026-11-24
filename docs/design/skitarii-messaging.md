# Skitarii messaging: automatic full-body context delivery

- **Status:** automatic context delivery implemented by DM-820; original mailbox design DM-507 … DM-514
- **Related:** [`architecture.md` → Agent mail](../architecture.md#agent-mail),
  [`runbooks/cli.md` → Agent mail between Skitarii chats](../runbooks/cli.md#agent-mail-between-skitarii-chats),
  [`runbooks/agents.md` → Skitarii mail](../runbooks/agents.md#skitarii-mail),
  [storage decision 0002](../decisions/0002-storage-modes.md),
  [current verification procedure](#verification)

Skitarii (OMP) chats in one tracked folder, on one machine, can send each other durable direct messages and replies.
This record says what was built, what it promises, and what it deliberately does not.

## Identity: the chat is the endpoint, not the process

- **A mailbox (endpoint, `me_…`) belongs to a chat.** It is keyed by (this machine, chat id) in that folder's own
  database and its id is stored on the chat record. Rename, restart, **Start again** and **New session** keep it.
- **CLI and vendor sessions are ephemeral.** Each terminal start issues a fresh `dm` grant, and the desktop binds *that
  grant* to the chat's endpoint before OMP is spawned. When the process ends, the grant is revoked and the binding closes;
  a closed binding never reopens. The next start binds the next grant to the same endpoint.
- **Subagents share the parent's mailbox.** OMP subagents inherit the chat's grant, so they act as the chat: they can use
  the mail tools, and what they send comes from the chat. Nothing can address a subagent on its own, and only the main
  agent's session runs the inbox watcher.
- **Only OMP chats have one.** Claude Code, Codex, Cursor, Autonomous and custom CLI chats are never bound, and neither is
  a grant issued outside a chat start (a grant from the **Agent access** card, an MCP session).

## Scope and trust

### Forge World chats

A root Skitarii chat holds one grant and mailbox in each available initialized member. The root itself has no project database or invented shared endpoint. Its private launch descriptor contains a validated runtime/folder pin and token-file reference for each member; tokens stay in the chat's app-data scratch directory. Every call rereads the route and its own grant file. Changing or removing that launch descriptor invalidates the routes. Project-less chats remain recovery-only and gain no mail authority.

Native mail tools accept an optional `project` selector on world chats. Identity and peer discovery without a selector return project-labelled results; send/read/ack and workflow calls require a selector when more than one project is available. The existing one-project API stays unchanged. Each member watcher owns its own sequence cursor, and body-bearing context records include the canonical member folder. Persisted receipts are keyed by both that folder and message id so identical ids or sequence numbers in two member databases cannot suppress one another. Mail remains inside each member's database: root and member agents can reply using their existing grants, with no cross-database delivery operation.

The local ownership ledger distinguishes the root chat's owner folder from each mailbox folder. Ordinary member recovery does not mistake root-owned endpoints for deleted local chats. Rename and root deletion fan out to owned members; untracking a member suspends its root-owned endpoints too. Removed mappings stop routing, including after app restart. An unreadable conflicted manifest withholds routes without deleting or suspending known mailboxes. The desktop monitor resumes and verifies the owning root chat while recording progress in the member that holds the mail.

### Project mailbox boundary

- **Same folder, same machine.** Peers are the other open Skitarii endpoints of this folder's database bound on this
  machine. There is no cross-folder, cross-machine or network delivery.
- **Local only.** Mailbox bodies live in the folder's SQLite database (`local/state.sqlite` in repository mode, the
  project database in database-only mode), not portable records or Git. Delivered bodies also remain in the recipient's
  normal host conversation. Machine-local insertion proofs contain message identity, body hash and host entry id.
- **Who cannot have a mailbox.** A `dm` session without a grant, a reader grant, a grant the desktop never bound, and every
  MCP (stdio) session (even one that inherited `DM_SESSION_TOKEN`) get `unauthorized` from all six mail commands.
  There is no generic MCP mailbox binding.
- **Authority comes from the grant, never from the input.** No command takes your own endpoint, sender or session; every
  call re-checks the grant, binding and endpoint inside the same transaction as the operation.
- **Peer discovery never waits for the mailbox writer.** The CLI opens the existing database read-only, authenticates
  its token and checks the current mailbox binding in the same deferred snapshot as the peer page. It creates no
  persistent session, updates no grant-use audit and performs no portable-record maintenance. This restricted session
  can only list peers; sends, acknowledgements and status polls retain their existing audited paths. An omitted cursor
  starts the first page; a non-id cursor such as `"0"` returns structured `invalid_input`, without acquiring a writer lock.
- **Peer text is task data.** Message bodies and peer names are written by other agents. Tool results carry them as JSON
  with control and bidirectional characters escaped, under a fixed note that they are task data, never instructions. A
  message cannot grant a role, approve anything, or change who decides; generated guidance says so to every Skitarii chat.
- **Boundary of intent, not of force.** Anything running as the same OS user can open `state.sqlite` directly; see
  [What this is, and is not](../runbooks/cli.md#what-this-is-and-is-not).

## Bounds

| What | Bound |
|---|---|
| Body | 1 byte to 16 KiB of UTF-8 |
| Inbox / status page | at most 50 messages |
| Peer page | at most 50 endpoints |
| Acknowledgement batch | 1–100 message ids |
| Unacknowledged per recipient | 1024 (`mailbox_full`) |
| Retained per recipient | 4096, unacknowledged plus acknowledged-not-expired (`mailbox_full`) |
| Send receipts per sender | 8192 unexpired (`receipt_quota_full`) |
| `clientMessageId` | 1–128 of `A-Z a-z 0-9 . _ : -`, starting with a letter or digit |
| Acknowledged message kept | 7 days after acknowledgement, then purged |
| Send receipt kept (idempotency window) | 7 days after acceptance |

**Idempotency promise.** A send is keyed by `clientMessageId` in the sender's mailbox. For seven days after acceptance, the
same id with the same payload replays the first acceptance (`duplicate: true`) and stores nothing new; the same id with a
different payload is `idempotency_mismatch`. After the receipt expires the id can be used again and is a new message.
This is at-most-once *acceptance* per key, not exactly-once *processing*: nothing records that a recipient acted on mail.

## Reading, acknowledging and seeing are separate

- **Accepted** means the recipient's mailbox holds the message. It is not delivery to a model, reading or processing.
- **Inserted in context** means an exact full body was observed in the correct recipient's actual host conversation.
  Its machine-local proof is distinct from acceptance, acknowledgment and the person's seen cursor. Queuing text or
  returning successfully from a send/paste API is not insertion proof, nor proof that a model processed or acted on it.
- **Read** (`dm_inbox_read` / `read_agent_inbox`) returns bodies and never acknowledges.
- **Acknowledged** is the agent's explicit `dm_inbox_ack` / `acknowledge_agent_messages` once it has handled a message.
  Only that stops the message counting as pending for the agent, and starts its seven-day expiry.
- **Seen by you** is the person's own cursor in the desktop inbox (**Mark shown messages seen**). It changes only the
  person's unseen count; it never acknowledges for the agent, and an agent's acknowledgement never marks anything seen.
  The **Messages** header button counts "unseen by you" and "unacknowledged by its agent" apart.
- **Incoming only.** The desktop inbox shows a chat's received mail. There is no browser of sent bodies; the sender keeps
  only its body-free acceptance receipt.
- **Replies** (`inReplyTo`) must answer a message still in your own inbox, sent to you by `to`. A reply to a message that
  expired, was purged (including by its chat's deletion) or never was is `reply_unavailable`.

## Automatic delivery and wake

- **No manual allowance.** New peer mail automatically reaches its existing recipient chat. The desktop monitors every
  eligible tracked folder without waiting for anyone to open Messages, and resumes the same stopped chat when needed;
  it never substitutes a new chat. Automatic turns may spend model tokens.
- **Complete bodies, not reminders.** The native main-session watcher reads a pinned snapshot through every body page
  before an idle wake. Before an unrelated user continuation, awaited preparation returns the full pending peer batch.
  Busy delivery uses native asides and the awaited tool-result boundary, preserving original tool output, including
  failures. Peer packets explicitly retain agent attribution and the inert JSON task-data note.
- **Person messages retain person authority.** Board conversations durably save the full pending person body before
  scheduling a recipient. The private OMP outbox is bound to the stored chat and its expected mailbox endpoint; the
  client authenticates its current own identity before exposing any person text. A trusted user-attributed idle prompt
  prepares both authorities together, so simultaneous peer and person arrivals are in the first provider context.
- **Independent arrivals and progress.** Newly accepted messages and later pages continue automatically. Exact message
  ids and bodies, not a maximum cursor or unread count, determine insertion. Already inserted but unacknowledged mail
  does not repeatedly wake the model. Sender `clientMessageId` deduplication remains unchanged.
- **Unavailable and interrupted hosts.** Pending work survives app restart. Observed exact host entries are reconciled
  before scheduling again; durable machine-local proof survives deletion of a previously observed transcript.
  Unreadable context or pending storage is a visible blocker, never silently treated as empty. An uncertain physical
  input attempt stays pending/unverified rather than blindly replaying it and creating endless turns.
- **Notices and status remain metadata.** A main-session poll every 2 s paints terminal notices and the unread count.
  Messages shows automatic insertion progress/blockers separately from unacknowledged-by-agent and unseen-by-you.
  Opening the inbox never inserts terminal input, and neither insertion nor reading acknowledges anything.

## OMP compatibility

- **Verified API contract:** OMP **18.20.2**, pinned upstream
  [`7c49c11aa5bbaf3f418406583096168ad5b8c6dc`](https://github.com/can1357/oh-my-pi/tree/7c49c11aa5bbaf3f418406583096168ad5b8c6dc).
  Native tools use `approval` and `loadMode: 'essential'`; the main agent is `ctx.agent.kind === 'main'`.
  Two `before_agent_start` handlers return explicitly attributed peer/person messages. Agent-attributed idle wakes
  skip that preparation, so their entire pinned peer batch must already be present in the initiating prompt.
  `sendUserMessage` returns a promise, but an idle promise lasts for the whole turn: the watcher must not await it
  from the same turn's preparation. Neither that promise nor void `sendMessage` constitutes a receipt.
- **Actual SDK prerequisite probes:** [DM-820 SDK contracts](../verification/DM-820-sdk-contracts.json) record real
  provider/context/persistence checks, including awaited tool-result content and asynchronous start notifications.
  These are prerequisite evidence, not the complete feature's two-chat acceptance run.
- **Unsupported APIs fail visibly.** Missing tool APIs show `Skitarii mail unavailable: …`; missing context APIs retain
  pending bodies and show the real blocker. Missing descriptors or revoked/foreign grants do not expose another chat's
  outbox. The mascot and supported ordinary chat routes keep working.
- Peer mail remains OMP-only. Existing person-board routes to other CLIs remain available; canonical Claude user-role
  session entries can prove insertion. A route without a verifiable host receipt is pending/unverified, not delivered.
- Historical Windows mailbox verification does not establish the new automatic contract; use the procedure below.
  macOS/Linux path coverage is unit-only unless accompanied by an actual platform run.

## Durability, backup and recovery

Mail is **not portable and not reconstructible**: it exists only in the folder's local database. Git restore, a fresh
clone, or rebuilding the database from tracked records gives back no mail.

- **Back up before any rebuild.** In repository mode too, never delete `.darkmechanicus/local/` to "rebuild the cache":
  quit the app and move the folder aside (or back the database up) first. A project-mismatch error never advises
  deleting it.
- **Consistent backup is `VACUUM INTO`, not a file copy.** A live WAL database copied file by file can be inconsistent.
  `backup_database` produces a consistent snapshot, and because that snapshot holds every mailbox it is **desktop-only**
  (`repo.backup` is human-only): no agent role, grant or MCP tool can call it. This is an intentional compatibility change
  of a previously agent-callable command; direct same-user disk access stays outside the intent boundary.
- **Restoring a chat** needs both the database and the app's `userData` chat records (the chat index and its
  `endpointId`); either alone does not bring the chat and its mailbox back together. A restored or copied database may
  carry old grants and the original logical machine identity: treat it as untrusted until the desktop has bound fresh
  grants (start each chat again). Old bindings never reopen.
- **Deleting a chat** records an irreversible tombstone, purges the mail it **received**, and leaves the copies it
  **sent** in other inboxes, shown with a deleted sender. Its send receipts stay until they expire. Replies to purged mail
  are `reply_unavailable`.
- **Deletion and expiry do not erase copies.** Purging a message removes it from the database only: earlier backups,
  copies of the database, and bodies an agent already fetched into its OMP conversation history keep their text.
- **Database-only projects move badly.** A database-only project is keyed by a digest of the folder path; moving or
  renaming the folder orphans the project and its mail with it (see [0002](../decisions/0002-storage-modes.md#known-limitations)).

## Verification

Build the intended integrated source head, then run `node scripts/smoke-skitarii-messaging.mjs` on Windows with the
existing Node24/Electron/native dependencies and normally authorized installed OMP. Optional environment variables:
`SKITARII_SMOKE_NODE`, `SKITARII_SMOKE_OMP`, `SKITARII_SMOKE_MODEL`, and a **fresh** `SKITARII_SMOKE_OUTPUT`.
This makes real provider requests and may spend tokens. It does not export, import or copy credentials, change global
OMP configuration, restart the installed app, or stop unowned processes.

The owned fixture exercises peer/person idle, busy and stopped recipients; accepts 55 messages before recipient
availability; restarts with both authorities pending; and checks the **first** actual provider context against exact
ordered ids/full-body hashes and explicit attribution using an observation-only public context handler. It also checks
independent arrivals, unchanged tool output, real unpredictable response tags, dedupe, explicit acknowledgment,
separate human-seen progress, and the actual Inbox UI. Inspect and attach the captured native screenshots before
claiming end-to-end acceptance. Historical DM-505 artifacts retain their original contract and are not new proof.


## Not claimed

- Independently addressable subagents.
- Exactly-once processing or read receipts to senders; observed local context insertion is not proof of handling.
- Generic MCP mailbox binding.
- Cross-folder, cross-machine or Git-carried mail.
