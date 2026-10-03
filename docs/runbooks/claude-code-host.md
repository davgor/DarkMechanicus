# Dispatch a worker in Claude Code

In Claude Code your session is the orchestrator (see [the working model](mcp-setup.md#working-model-your-session-is-the-orchestrator)). For each ticket you claim it and start a subagent as its worker. This runbook covers the Claude Code parts: the model catalog to register, one agent definition per model and effort, and the dispatch call. The shipped skills stay vendor-neutral, so model names live here and not there.

**Needs a build with ticket sizes and efforts.** `register_host` `efforts` and `claim_ticket` `worker.effort` work only on an app that includes them (skills version 1.3.0 or later; `get_capabilities` reports `skillsVersion`). An older installed app predates them, so rebuild or update the app, then start a new session so the MCP server restarts. Until then, leave `efforts` out of `register_host` and `effort` out of `claim_ticket`.

## 1. Register the catalog

An example catalog for the current model family. Cost tiers are relative within the catalog, and reasoning levels say what you trust each model with.

| Model | Cost tier | Reasoning levels | Efforts |
|-------|-----------|------------------|---------|
| Haiku 4.5 (`claude-haiku-4-5-20251001`) | low | routine | low |
| Sonnet 5.5 (`claude-sonnet-5-5`) | normal | routine, multi_step | low, medium, high |
| Opus 5.5 (`claude-opus-5-5`) | high | routine, multi_step, deep | low, medium, high |

As a `register_host` call (a model's `contextWindowTokens`, `skills`, and `latencyTier` are optional and left out):

```json
{
  "hostId": "claude-code",
  "hostType": "claude-code",
  "catalogRevision": "2026-10-03",
  "tools": ["repo_read", "repo_write", "shell", "test_execution"],
  "canSelectWorkerModel": true,
  "models": [
    {
      "id": "claude-haiku-4-5-20251001",
      "label": "Haiku 4.5",
      "reasoningLevels": ["routine"],
      "efforts": ["low"],
      "modalities": ["text", "images"],
      "costTier": "low"
    },
    {
      "id": "claude-sonnet-5-5",
      "label": "Sonnet 5.5",
      "reasoningLevels": ["routine", "multi_step"],
      "efforts": ["low", "medium", "high"],
      "modalities": ["text", "images"],
      "costTier": "normal"
    },
    {
      "id": "claude-opus-5-5",
      "label": "Opus 5.5",
      "reasoningLevels": ["routine", "multi_step", "deep"],
      "efforts": ["low", "medium", "high"],
      "modalities": ["text", "images"],
      "costTier": "high"
    }
  ]
}
```

- Claude Code's [effort documentation](https://code.claude.com/docs/en/model-config#adjust-effort-level) lists Opus 5.5 and Sonnet 5.5 as supporting the levels `low`, `medium`, `high`, `xhigh`, and `max`. Dark Mechanicus has three efforts, and they map one to one to `low`, `medium`, and `high`.
- Haiku 4.5 is not on that list, so by the documentation it has no effort setting. It is registered at `low` only: a claim at any other effort is refused, and its agent definition has no `effort` key.
- Register only the efforts you have an agent definition for (next section). A claim at an effort the model does not list is refused.
- Fable is left out because these docs cannot state its cost tier. Add it with a tier of your own if you use it.
- To change the catalog, register again with a new `catalogRevision`.

## 2. Define one agent per model and effort

An agent definition is a Markdown file under `.claude/agents/` with YAML frontmatter. The keys below come from Claude Code's subagent documentation, <https://code.claude.com/docs/en/sub-agents> (the older `docs.claude.com/en/docs/claude-code/sub-agents` address redirects there), checked on 2026-10-03.

| Key | Use |
|-----|-----|
| `name` | Required. The identifier you pass as `subagent_type`. |
| `description` | Required. When Claude should delegate to this agent. |
| `tools` | Optional, a comma-separated string or a YAML list. Omitted means the agent inherits every tool available to subagents, MCP tools included. MCP tools are named `mcp__<server>__<tool>`. |
| `model` | Optional: an alias (`sonnet`, `opus`, `haiku`, `fable`), a full model ID such as `claude-opus-5-5`, or `inherit`. |
| `effort` | Optional. The effort level while this subagent is active. It overrides the session's effort, and without it the agent inherits the session's. Accepts `low`, `medium`, `high`, `xhigh`, or `max`, and which of those work depends on the model. |

Use full model IDs in `model`. An alias follows the latest model of its family, and resolves to the session's own model when the session is on that family, so it may not be the model your catalog names.

Name each definition `worker-<model>-<effort>` and keep one for every model and effort pair in the catalog: `worker-haiku-low`, `worker-sonnet-low`, `worker-sonnet-medium`, `worker-sonnet-high`, `worker-opus-low`, `worker-opus-medium`, and `worker-opus-high`. For example, `.claude/agents/worker-sonnet-low.md`:

```markdown
---
name: worker-sonnet-low
description: Dark Mechanicus worker on Sonnet 5.5 at low effort. Does one claimed ticket from its execution packet.
model: claude-sonnet-5-5
effort: low
tools: Read, Write, Edit, Grep, Glob, Bash, mcp__darkmechanicus__heartbeat_attempt, mcp__darkmechanicus__submit_attempt, mcp__darkmechanicus__fail_attempt, mcp__darkmechanicus__list_comments, mcp__darkmechanicus__add_comment
---

You are a Dark Mechanicus worker. Follow the worker guide (`skills/worker.md`) and do exactly the one ticket in the execution packet you are given.
```

`worker-haiku-low` is the same file with `model: claude-haiku-4-5-20251001` and no `effort` line. The other five change only `name`, `description`, `model`, and `effort`.

The `tools` list gives the worker the reporting tools and its own comments, and withholds `accept_attempt`, `reject_attempt`, and the rest of the orchestrator's tools. Match the `mcp__darkmechanicus__` prefix to the server name in your `.mcp.json`.

The Agent tool call takes `subagent_type` and an optional `model` alias (`haiku`, `sonnet`, `opus`, `fable`), and it has no effort parameter. A `model` on the call overrides the definition's. So the effort comes only from the definition, which is why there is one definition per model and effort. Leave `model` off the call.

## 3. Dispatch a worker

1. `match_capabilities` for the ticket. Read `recommended`: a `modelId`, an `effort`, and `reasons`.
2. Use it unless you have a stated reason not to. The matching agent is `worker-<model>-<effort>`.
3. `claim_ticket` with a `worker` that holds `label`, `modelId`, `hostId`, `catalogRevision`, `effort`, and `rationale`.
4. Call the Agent tool with that `subagent_type` and a prompt that holds the packet. Follow step 4 of [`skills/orchestrator.md`](../../skills/orchestrator.md): the definitions above list the reporting tools, so hand the worker the packet with its claim token and it heartbeats and submits itself. For a definition without those tools, keep the token, give the worker only the ticket content, and make the calls yourself. Never write the token to a file or a commit.
5. Review the result and accept or reject it.

### Example: a routine micro ticket

```json
{ "tool": "match_capabilities", "result": { "recommended": { "modelId": "claude-haiku-4-5-20251001", "effort": "low" } } }
```

```json
{
  "tool": "claim_ticket",
  "input": {
    "runId": "<runId>",
    "ticketId": "<ticketId>",
    "worker": {
      "label": "worker-haiku-low",
      "modelId": "claude-haiku-4-5-20251001",
      "hostId": "claude-code",
      "catalogRevision": "2026-10-03",
      "effort": "low",
      "rationale": "Recommended by match_capabilities: routine micro ticket."
    }
  }
}
```

Then `Agent(subagent_type: "worker-haiku-low", prompt: "<worker guide pointer and the packet>")`.

### Example: escalating after a rejection

The reviewer rejects the attempt. `match_capabilities` now recommends one step up: the cheapest eligible model one tier above the last attempt's. A tier is the cost tier, then the highest reasoning level. Here that is Sonnet 5.5, at the ticket's normal effort.

```json
{
  "tool": "claim_ticket",
  "input": {
    "runId": "<runId>",
    "ticketId": "<ticketId>",
    "worker": {
      "label": "worker-sonnet-low",
      "modelId": "claude-sonnet-5-5",
      "hostId": "claude-code",
      "catalogRevision": "2026-10-03",
      "effort": "low",
      "rationale": "Attempt 1 rejected on the low-cost model (missed the empty-input case); escalating one tier."
    }
  }
}
```

Then `Agent(subagent_type: "worker-sonnet-low", ...)`, with the rejection reasons added to the prompt. With this catalog, repeated rejections of a routine micro ticket step through Haiku at low, Sonnet at low, Opus at low, and then Opus at medium, because nothing sits above Opus. Report repeated escalations as a profile proposal (see [`skills/orchestrator.md`](../../skills/orchestrator.md)).

## If the effort cannot be set

A subagent whose definition sets no `effort` runs at the session's effort. That applies to Haiku, which has no effort setting, and to any host that cannot honour the key. Do not register or claim an effort you cannot deliver. If you must dispatch anyway, claim the effort you intended and say in the `rationale` that the worker ran at the session's effort.

## Troubleshooting

- **`register_host` or `claim_ticket` rejects `efforts` or `effort`.** The installed app predates efforts. See the note at the top.
- **`claim_ticket` fails with `unsupported_capability`.** The claimed effort is not in the model's registered `efforts`, or the model fails a hard requirement. Claim an effort from the catalog, or register again with a new `catalogRevision`. The field is `worker.effort`, not a top-level `effort` or `reasoningEffort`.
- **A worker seems to run at another effort than claimed.** Run `/tasks`: it shows each subagent's model, and its effort when the definition sets one (Claude Code 2.1.242 or later). The `CLAUDE_CODE_EFFORT_LEVEL` environment variable beats the frontmatter, and `maxEffortLevel` or an organization cap can lower it. See <https://code.claude.com/docs/en/model-config#adjust-effort-level>.
- **The worker cannot call a reporting tool.** Its `tools` list lacks it, or the prefix does not match your server name. Fix the definition, or keep the token and make the calls yourself.
