# Skitarii messaging: direct messages, replies and inbox notifications (as built)

- **Status:** as built, epic "Skitarii communications" sprint 1 (DM-507 … DM-513), documented by DM-514
- **Related:** [`architecture.md` → Agent mail](../architecture.md#agent-mail),
  [`runbooks/cli.md` → Agent mail between Skitarii chats](../runbooks/cli.md#agent-mail-between-skitarii-chats),
  [`runbooks/agents.md` → Skitarii mail](../runbooks/agents.md#skitarii-mail),
  [storage decision 0002](../decisions/0002-storage-modes.md),
  acceptance procedure [`verification/skitarii-messaging.md`](../verification/skitarii-messaging.md)

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

- **Same folder, same machine.** Peers are the other open Skitarii endpoints of this folder's database bound on this
  machine. There is no cross-folder, cross-machine or network delivery.
- **Local only.** Mail lives only in the folder's SQLite database (`local/state.sqlite` in repository mode, the project
  database in database-only mode). No portable record, Git file, outbox entry, event body or history index carries it.
- **Who cannot have a mailbox.** A `dm` session without a grant, a reader grant, a grant the desktop never bound, and every
  MCP (stdio) session (even one that inherited `DM_SESSION_TOKEN`) get `unauthorized` from all seven mail commands.
  There is no generic MCP mailbox binding.
- **Authority comes from the grant, never from the input.** No command takes your own endpoint, sender or session; every
  call re-checks the grant, binding and endpoint inside the same transaction as the operation.
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

## Notifications: passive by default, one explicit wake

- **Notice and status.** In the main agent's session, the extension polls `get_agent_mail_status` every 2 s (one process
  at a time). New arrivals become one OMP `ui.notify` naming up to three senders and a persistent status line
  `Skitarii mail: N unread`. These paint the terminal; they are not processing, and there are no operating-system
  notifications. A restart may repeat a notice.
- **Passive reminder.** While mail is pending, the main agent's *next natural turn* (one the person or the run starts)
  carries one constant reminder to check the inbox. It never contains peer text and never starts a turn: an idle model
  stays idle until something else prompts it.
- **Allow one inbox wake.** The person may arm one wake for a chat in the desktop inbox. It is explicit (only the desktop
  can arm it, never an agent), non-accumulating (arming again while armed changes nothing) and one-shot. The extension
  consumes the credit with `take_agent_mail_wake` *before* it sends one constant follow-up turn
  (`deliverAs: 'followUp'`, queued behind a running turn), so the credit is spent even when that dispatch then fails
  (OMP stopped, the turn errored). It is never refunded, retried or re-armed; the UI reports the wake as attempted, never
  as read. Allowing a wake may spend model tokens.
- Peer content reaches the model only as an inbox tool result. The reminder and the wake text are fixed,
  extension-authored strings; they are the only text the extension injects as a custom message, which OMP maps to the
  developer role (planning research of the OMP extension API).

## OMP compatibility

- **Provenance.** Planning verified OMP's upstream extension types and lifecycle at **v18.18.0**. DM-511 built against,
  and ran a no-model RPC smoke of, the installed **OMP 18.20.2** (Windows, 2026-11-15): tool registration
  (`approval`, `loadMode: 'essential'`), `ctx.agent.kind`, `ui.notify`/`ui.setStatus`, `before_agent_start` and
  `sendMessage(…, { deliverAs: 'followUp', triggerTurn: true })`. In 18.20.2 a wake turn does not fire
  `before_agent_start`, so the wake text carries the hint itself.
- **Unsupported APIs fail visibly.** Each host API is detected before use. An OMP without the tool API shows the status
  `Skitarii mail unavailable: …` and registers no tools; without `sendMessage` the wake credit is never taken; a launch
  without a mailbox shows `Skitarii mail unavailable (descriptor_missing)`. The mascot keeps working.
- Windows is the only platform verified end to end; macOS and Linux paths are unit-tested only.

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

## Not claimed

- Independently addressable subagents.
- Exactly-once processing, delivery receipts or read receipts (a wake attempt is not a read receipt).
- Generic MCP mailbox binding.
- Operating-system notifications, or waking an idle model without the person's explicit **Allow one inbox wake**.
- Cross-folder, cross-machine or Git-carried mail.
