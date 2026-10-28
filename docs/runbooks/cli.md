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
ticket, and issuing or revoking a further grant. An agent cannot promote itself, and approval stays
in the app.

`plan.save` is granted only if you tick **May save plans**, and only for a planner or orchestrator.
Without it the agent prepares a draft and you press Save.

## Setting a folder up is not a CLI job

`initialize_repository` is refused from the CLI, and cannot be otherwise: the grant that would
authorize it lives in the database that initializing is about to create. Set a folder up in the
desktop app, issue a grant there, then use the CLI. Running it anyway changes nothing and says why.

## What this is, and is not

It is a boundary of intent, not of force. Anything that can run `dm` can also open
`state.sqlite` directly, and nothing here prevents that. What the design buys is that every
delegation is an explicit, expiring, revocable row a person created — so going around it is
unambiguous rather than indistinguishable from ordinary use. On a shared or untrusted machine,
that is not the same as a security boundary, and should not be relied on as one.
