# Use the `dm` CLI

`dm` runs one Dark Mechanicus command against a repository and prints JSON. It is the same command
table the desktop app and the MCP server use, over a one-shot process instead of a long-lived
session, so an agent can drive the project with nothing configured in its host.

That matters where MCP cannot be configured at all — an enterprise `managed-mcp.json` on the
machine, for instance, stops Claude Code from registering any server. The CLI is unaffected: it is
an ordinary command, not an MCP server.

```sh
npm run build                 # produces out/main/cli.js
node out/main/cli.js --help
```

## Discover, then call

```sh
node out/main/cli.js --list
node out/main/cli.js --describe claim_ticket
node out/main/cli.js call list_epics '{}'
node out/main/cli.js call get_epic '{"epicId":"ep_…"}'
```

Commands take either spelling: `claim_ticket` (as the skills and the MCP tools name them) or
`claimTicket`. `--list` reports both, with the capability each needs and whether it changes
anything. Output is `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message"}}`; exit code
`0` for success, `1` when the command failed, `2` for a usage mistake. Everything else goes to
stderr, so the output pipes into `jq` cleanly.

`--repo` picks the repository (default `$DARKMECHANICUS_REPO`, else the working directory).

## Pass JSON from a file: `--args-file`

Inline JSON has to survive the shell's quoting, and on Windows it often does not: PowerShell and `cmd` strip
the double quotes of an inline argument. `call` therefore also reads its arguments from a file, or from
standard input:

```sh
node out/main/cli.js call <command> --args-file <path>      # a file holding one JSON object
cat args.json | node out/main/cli.js call <command> -       # a lone - reads standard input
```

Use one source: inline JSON together with `--args-file` or `-` is refused with exit code `2`, as is
`--args-file` on anything but `call`. A UTF-8 byte order mark at the start of the file is ignored. Inside the
JSON a backslash must be doubled (`"C:\\Users\\me\\shot.png"`), or the path written with forward slashes
(`"C:/Users/me/shot.png"`); an undoubled backslash is invalid JSON, and the error says so.

## Launch named Kanban cards

When explicitly asked to run cards, an external session with an **orchestrator** grant may queue named
cards without pressing desktop Play or spawning duplicate desktop chats. Discovery exposes
`launch_kanban_cards` / `launchKanbanCards`, its `kanban.launch` capability and the nonempty `cardIds`
contract. MCP exposes the same command and rules to orchestrators.

```sh
node out/main/cli.js --describe launch_kanban_cards
node out/main/cli.js call launch_kanban_cards '{"cardIds":["kc_…"]}'
node out/main/cli.js call launch_kanban_cards '{"cardIds":["kc_…","kc_…"]}'
node out/main/cli.js call claim_kanban_card '{"cardId":"kc_…"}'
```

Use real stable IDs from `list_kanban_cards`, not display keys. A single-item list launches one card;
a nonempty multi-item list launches a batch. There is no launch-all. On Windows, put the same object
in an args file and use `call launch_kanban_cards --args-file <path>` to avoid shell quoting.

The entire batch is authorized and validated before mutation. Unknown or ineligible cards return
`invalid_state` with actionable `details.cards` entries (`cardId`, `code`, `message`); nothing launches.
Malformed or empty ID lists fail `invalid_input`. Duplicate IDs are ignored; pending requests retried
before claim do not create new events or attempts. Backlog and In progress with no open attempt may
be queued, including locally expired claims. Active claims, Ready for review and Done are refused,
never reset; a retry after claim or submission cannot queue another attempt.

Launch only queues pending Play. **Claim** creates the leased attempt and returns its secret token;
continue with `heartbeat_kanban_card`, then `submit_kanban_card` (Ready for review) or `fail_kanban_card`.
Keep the token secret. Reader, planner, worker and reviewer sessions cannot launch. Revoked or expired
CLI grants are refused before every command. Desktop Play remains human-only and starts a chat.
**Approval**, kick-back, card deletion and checkpoint approval remain human-only; launch grants none
of those powers and changes no epic execution.

## Attach an image: `add_attachment`

An agent adds an image from a file on its own machine, then names the returned id on the record it belongs
to. The file must be a PNG or JPEG of at most 10 MiB and 8000 pixels per side, and sit in an allowed folder:
the project and its worktrees, the system temp folder, or the operating system's screenshot folder. A record
holds at most 20 images. The session needs a grant that may write attachments (an orchestrator, planner or
worker grant); a reader is refused with `unauthorized`.

PowerShell. The JSON goes in a file, and `ConvertTo-Json` doubles the backslashes for you:

```powershell
$env:DARKMECHANICUS_REPO = 'C:\path\to\repo'      # or run from the repository
Add-Type -AssemblyName System.Drawing
$shot = Join-Path $env:TEMP 'dm-example.png'
$bmp = New-Object System.Drawing.Bitmap 64, 48
$bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$argsFile = Join-Path $env:TEMP 'dm-add-attachment.json'
@{ path = $shot; label = 'Settings page'; purpose = 'evidence' } | ConvertTo-Json | Set-Content -Encoding utf8 $argsFile
node out/main/cli.js call add_attachment --args-file $argsFile
```

Git Bash. Inline JSON works, with forward slashes in the path. `cygpath -m` turns a Unix-style path into the
`C:/…` form that `node` understands:

```sh
shot="$(cygpath -m "$TEMP")/dm-example.png"      # a PNG you saved, such as a screenshot
node out/main/cli.js call add_attachment "{\"path\":\"$shot\",\"label\":\"Settings page\",\"purpose\":\"evidence\"}"
```

Both print the staged image as JSON: `{"ok":true,"data":{"id":"im_…","sha256":"…","mime":"image/png","bytes":141,"width":64,"height":48,"label":"Settings page","purpose":"evidence","owner":null,…}}`. `owner` is `null` until a record claims the image.
Pass the id on the record when you report, for example in the arguments of `submit_attempt`:
`"evidence":{"checks":[…],"criteria":[…],"attachments":["im_…"]}`. Reference images go in the `attachments` of
`add_comment`, `create_kanban_card`, `update_kanban_card`, `create_ticket`, `update_ticket` and
`update_plan_draft` tickets. To look at an image, run
`call get_attachment --args-file <path>` with `{"attachmentId":"im_…","as":"file"}`: the result carries a local
`path` to open (`"as":"metadata"` returns the label and size only). An image that no record claims is removed
after a while.

## Authority: there is no `--role`

Over MCP a session's role comes from its launch flags, and that is trustworthy only because a
person wrote the configuration the host launches from. A local CLI has no such property — whatever
runs `dm` chooses its own flags — so asking for a role on the command line would be the same as
granting it to yourself.

**A `dm` session is a reader until a person grants it a role.** A reader may read: list epics, read
plans and tickets, search history. Everything else is refused with `unauthorized`.

To give an agent more, issue a grant in the desktop app: the folder's **Agent access** card →
**Authorize an agent** → pick a role and how long it lasts. The token is shown once and never
again; the database keeps only its hash.

Keep the token in a file that only you can read — the better of the two paths:

```sh
umask 077 && printf '%s' 'dmg_…' > ~/.config/dm-token
node out/main/cli.js --token-file ~/.config/dm-token call create_epic '{"title":"…"}'
```

The environment works too, and is more convenient for a one-off:

```sh
export DM_SESSION_TOKEN='dmg_…'
node out/main/cli.js call create_epic '{"title":"…"}'
```

Neither hides the token from you or from anything running as you: an environment variable is
readable from the process table (`ps ewww`, `/proc/<pid>/environ`), and nothing checks the mode of
a token file. Both keep it out of the command line, which is the part that ends up in shell
history. Treat a token as a password with an expiry.

A grant expires, can be revoked from the same card, and records when it was last used. A token that
is expired, revoked, unknown, or was issued on another machine fails the command outright rather
than quietly dropping back to reader, so a stale token is never mistaken for a deliberate choice.
The grant is checked again before every command, so revoking one stops a session that is already
running, not only the next one to start.

"Another machine" means another `local/machine.json`. That is what makes a token useless if it
leaks on its own — into a log, a transcript, shell history. It is no defence against someone who
has copied the whole database, and is not meant to be.

### What a grant can never carry

Capabilities reserved to a person are not grantable, whatever role is chosen: approving a sprint
checkpoint, authorizing auto-continue, granting a retry, queueing a run, deleting an epic or a
ticket, issuing or revoking a further grant, and pressing Play on, approving or kicking back a
Kanban card (`kanban.play`, `kanban.review`). A granted orchestrator can create, edit and claim
cards and report on them, but only after you press Play. An agent cannot promote itself, and
approval stays in the app.

`plan.save` is granted only if you tick **May save plans**, and only for a planner or orchestrator.
Without it the agent prepares a draft and you press Save.

## Setting a folder up is not a CLI job

`initialize_repository` is refused from the CLI, and cannot be otherwise: the grant that would
authorize it lives in the database that initializing is about to create. Set a folder up in the
desktop app, issue a grant there, then use the CLI. Running it anyway changes nothing and says why.

## Hand an epic to Linear: `dm transfer linear`

```sh
node out/main/cli.js transfer linear --epic ep_…
node out/main/cli.js transfer linear --epic ep_… --json
```

It prints the kickoff for the agent that moves a saved epic to a Linear project: the same text as
the in-app chat and Copy prompt, with the darkmechanicus-linear-transfer guide. After it come a
summary of the packet (issues per milestone and the first issues in order), the setup lines for
Linear's MCP server in each CLI, and how to give the agent an orchestrator grant (the Agent access
card, then `$DM_SESSION_TOKEN`). When the person has not pressed Transfer to Linear yet, the first
line says the transfer is not authorized.

`--json` prints the packet itself. `--epic` and `--json` belong to this mode only.

It is read-only and always runs as a reader, so it needs no grant and presents none. It is the one
mode that prints text instead of the `{"ok":…}` envelope. An unknown epic, or one with no saved
plan, prints the error on stderr and exits `1`.

## What this is, and is not

It is a boundary of intent, not of force. Anything that can run `dm` can also open
`state.sqlite` directly, and nothing here prevents that. What the design buys is that every
delegation is an explicit, expiring, revocable row a person created — so going around it is
unambiguous rather than indistinguishable from ordinary use. On a shared or untrusted machine,
that is not the same as a security boundary, and should not be relied on as one.
