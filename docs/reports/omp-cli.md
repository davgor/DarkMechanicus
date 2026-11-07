# OMP (oh-my-pi) CLI: what the installed `omp` does

Recorded on 2026-11-02 (US Central) against `omp/18.16.0` on Windows 11 (10.0.26200), for the OMP-as-default-chat-agent epic (ticket DM-406). Supersedes the second-hand OMP 18.11.2 lead in `docs/reports/autonomous-acp.md`.

## How it was run, and the limits of this report

- `omp` was installed by the orchestrator, with the person's approval, before this ticket's worker started (see 1). The worker installed nothing.
- The original 18.16.0 investigation used read-only subcommands or pty launches while signed out. No login or model turn was started. A launch with a positional prompt stopped at `Error: No API key found for anthropic.` (see 3). Section 5 adds later read-only signed-in recordings using the person's existing credentials.
- Source facts come from a shallow clone of `https://github.com/can1357/oh-my-pi` at tag `v18.16.0` (`git describe --tags` printed `v18.16.0`), kept outside the repository and never run or built. Paths below that start `packages/` or `docs/` are inside that clone.
- pty captures used a throwaway Node script, [`omp-cli/pty-capture.js`](omp-cli/pty-capture.js): `node-pty` 1.1.0 (the app's own dependency, so ConPTY) feeding `@xterm/headless` 6 (the app's xterm.js major). It sets `TERM=xterm-256color` and `COLORTERM=truecolor`, the same two variables `src/main/terminals/terminalEnv.ts` sets for every chat terminal. **A ConPTY capture shows the bytes ConPTY forwards, not everything `omp` wrote**: some sequences `omp` is documented to send, such as `?2026h` and the startup queries, did not appear in the capture, and I did not establish whether ConPTY dropped them or `omp` did not send them. What `omp` emits is therefore taken from source in 7, and the captured list is marked as such.
- Side effects of running `omp` itself in `~\.omp`: it created `agent\agent.db`, `models.db`, `history.db`, `skill-descriptions.db`, `cache\`, `logs\`, `natives\`, `run\`, `sessions\`; it renamed `agent\settings.json` (the installer wrote `shellPath` there) to `settings.json.bak` and migrated it into `agent\config.yml`; and the first-run setup wizard (I pressed Escape to skip every step, nothing was chosen) wrote `setupVersion: 2` to `config.yml`.
- Signed-in status was subsequently recorded and checked in the dev desktop app (section 5, DM-441). Item 9 was run on a dev build of the app from this worktree with a throwaway profile (see 9).

## 1. Install

The official Windows installer is `https://omp.sh/install.ps1`. The reviewed copy that was run is `scratchpad\omp-install.ps1` (375 lines, sha256 `bf9541b2ccb90562e5c1fdd0d2878aa156df54cbac2247e211a0d5e0104e8b3f`), invoked as `omp-install.ps1 -Binary`, which is what `irm https://omp.sh/install.ps1 | iex` does when no Bun is installed. Its documented forms (script header, lines 6 and 9):

```powershell
& ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary
& ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary -Ref v18.8.9
```

Output of the run, as given by the orchestrator:

```
Fetching latest release...
Using version: 18.16.0
Downloading omp-windows-x64.exe...

[OK] Installed omp to C:\Users\davgo\AppData\Local\omp\omp.exe
Adding C:\Users\davgo\AppData\Local\omp to PATH...
Found bash shell: C:\Program Files\Git\bin\bash.exe
[OK] Configured shell path in C:\Users\davgo\.omp\agent\settings.json
Restart your terminal, then run 'omp' to get started!
```

Facts from the script and the disk:

- **Where it lands:** `%LOCALAPPDATA%\omp\omp.exe` (override with `PI_INSTALL_DIR`; script line 34). The installer appends that folder to the **user** PATH (`SetEnvironmentVariable("Path", ..., "User")`, lines 337-342), so a process started before the install, such as the app, does not see it until it restarts. The app should look for `%LOCALAPPDATA%\omp\omp.exe` as well as PATH.
- **File names on Windows (binary install):** one file, `omp.exe`, 243,591,168 bytes (`ls -la`), sha256 `c249a9ed0a57c748fb1247d8ee9e2d0fe1b13229266ce74d8810a76a591e21fc`. It is a self-contained compiled Bun executable: no `.cmd`, no shim, no Node or Bun needed at runtime. The installer checks the release's published sha256 before replacing it (lines 311, 327).
- **Bun route (not run):** with Bun >= 1.4.4 on PATH the default install is `bun install -g @oh-my-pi/pi-coding-agent` (script lines 223-282; the npm package declares `engines: bun >= 1.4.4`), which makes a Bun global shim, not a standalone `.exe`. The script installs Bun first (`irm bun.sh/install.ps1 | iex`) when `-Source`/`-Ref` is given and Bun is absent. The app should treat the binary install as the Windows default.
- **Runtime need on Windows:** a bash. The installer looks for `C:\Program Files\Git\bin\bash.exe`, then `bash.exe` on PATH, and writes `{"shellPath": ...}` (it printed `Found bash shell: C:\Program Files\Git\bin\bash.exe`). `omp` still started with no model and no bash trouble here, but its `bash` tool needs it.
- **macOS and Linux (from the repository README and installer docs; not runnable here):** `curl -fsSL https://omp.sh/install | sh`; Homebrew `brew install can1357/tap/omp`; Bun `bun install -g @oh-my-pi/pi-coding-agent`.
- **Update:** `omp update --check`:

```
$ omp update --check
Current version: 18.16.0
✔ Already up to date
exit=0
```

## 2. Version

```
$ omp --version
omp/18.16.0
exit=0
```

Regex (anchored, whole line, optional pre-release or build suffix kept in group 2): `^omp\/(\d+\.\d+\.\d+)([-+][0-9A-Za-z.+-]+)?$`. It matches `omp/18.16.0`. The suffix part is a guess for canary builds (`omp update --canary` exists); only the plain form was observed.

`omp --help` starts with a different line, `omp v18.16.0` (note the `v` and the space), and the TUI banner prints `v18.16.0`. Parse `--version`, not `--help`.

## 3. Launch flags for an interactive TUI session

`omp --help` (full text, signed out; the flags that matter are bold in the table after it):

```
omp v18.16.0

USAGE
  $ omp [COMMAND]

ARGUMENTS
  MESSAGES   Messages to send (prefix files with @)

FLAGS
      --model=<value>                   Model to use (fuzzy match: "opus", "gpt-5.2"; exact with a provider: "openai/gpt-5.2")
      --smol=<value>                    Smol/fast model for lightweight tasks (or PI_SMOL_MODEL env)
      --slow=<value>                    Slow/reasoning model for thorough analysis (or PI_SLOW_MODEL env)
      --plan=<value>                    Plan model for architectural planning (or PI_PLAN_MODEL env)
      --goal=<value>                    Start fresh in goal mode (interactive only; bypasses autoResume; no positional prompt, startup plan mode, or explicit resume)
      --prewalk                         Switch from the active model to a fast/cheap model at the first edit/write after the plan's todo list exists (default off; see prewalk.enabled)
      --no-prewalk                      Disable prewalk, including prewalk.auto, even if prewalk.enabled is set
      --prewalk-into=<value>            Target model for prewalk (default the "smol" role)
      --plan-yolo                       Force read-only plan mode at start, auto-approve the plan on the model's first resolve call, then switch to --plan-yolo-into to implement it
      --plan-yolo-into=<value>          Target model for plan-yolo execution (default the "smol" role)
      --provider=<value>                Provider to use (legacy; prefer --model)
      --api-key=<value>                 API key (defaults to env vars)
      --system-prompt=<value>           System prompt (default: coding assistant prompt)
      --system-prompt-template=<value>  Handlebars system prompt template (mutually exclusive with --system-prompt)
      --append-system-prompt=<value>    Append text or file contents to the system prompt
      --allow-home                      Allow starting in ~ without auto-switching to a temp dir
      --profile=<value>                 Use an isolated profile for auth, sessions, settings, and caches
      --alias=<value>                   Create a shell shortcut for the selected profile and exit
      --cwd=<value>                     Directory to start in (overrides the launch cwd)
      --mode=<value>                    Output mode: text (default), json, rpc, or rpc-ui
      --config=<value>                  Load an extra config.yml-style overlay for this run (repeatable)
      --add-dir=<value>                 Add a workspace directory beyond the working directory (repeatable)
  -p, --print                           Non-interactive mode: process prompt and exit
  -c, --continue                        Continue previous session
  -r, --resume=<value>                  Resume a session (by ID prefix, path, or picker if omitted)
      --restore=<value>                 Resume a session as --resume does, then go on with what its last process left unfinished (the interrupted turn and the subagents it was running)
      --from-claude                     Import a Claude Code session into OMP
      --from-codex                      Import a Codex session into OMP
      --session-dir=<value>             Directory for session storage and lookup
      --no-session                      Don't save session (ephemeral)
      --models=<value>                  Comma-separated model patterns for Ctrl+P cycling
      --no-tools                        Disable all built-in tools
      --no-lsp                          Disable LSP tools, formatting, and diagnostics
      --no-pty                          Disable PTY-based interactive bash execution
      --tools=<value>                   Comma-separated list of tools to enable (default: all)
      --thinking=<value>                Set thinking level: off, minimal, low, medium, high, xhigh, max, auto
      --service-tier=<value>            OpenAI service tier for this session (none omits service_tier)
      --hide-thinking                   Hide thinking blocks in TUI output (display only, does not disable model thinking)
      --advisor                         Enable the advisor runtime (passively reviews each turn and injects notes)
      --wait-async                      Print mode: before exiting, wait for this run's background jobs and wake the session with each result (async.printWake); no time limit unless --max-time is set
      --external-thinking               Use a private scratchpad while disabling supported GPT, Claude, and Gemini reasoning (at your own risk: providers have flagged this request shape as abuse)
      --hook=<value>                    Load a hook/extension file (can be used multiple times)
  -e, --extension=<value>               Load an extension file (can be used multiple times)
      --no-extensions                   Disable extension discovery (explicit -e paths still work)
      --no-skills                       Disable skills discovery and loading
      --skills=<value>                  Comma-separated glob patterns to filter skills (e.g., git-*,docker)
      --no-rules                        Disable rules discovery and loading
      --no-context-files                Disable context files (AGENTS.md, CLAUDE.md, ...)
      --export=<value>                  Export session file to HTML and exit
      --no-title                        Disable title auto-generation
      --no-ui                           With --mode rpc or rpc-ui: run extensions headless (rpc-ui tool UI remains enabled)
      --print-thoughts                  Include thinking blocks in print mode text output
      --max-time=<value>                Stop the session after this duration (e.g., 600, 10m, 1h)
      --warn-cost=<value>               Warn once when the session's spend, subagents included, reaches this many USD
      --max-cost=<value>                Stop sending model requests once the session's spend reaches this many USD; requests already in flight can finish past it (print mode exits 3)
      --auto-approve                    Auto-approve all tool calls (skip approval prompts)
      --approval-mode=<value>           Override tools.approvalMode for this session (always-ask|always-ask-cached|write|yolo)
```

(The `--help` output continues with an examples block, a `COMMANDS` list of about 50 subcommands, and an environment-variable list; trimmed here. `--fork`, `--session`, `--provider-session-id`, `--prompt-cache-key`, `--trusted-extension`, `--plugin-dir` and `--yolo` are accepted but missing from `--help`: `packages/coding-agent/src/cli/flag-tables.ts`, and `docs/cli-reference.md`.) The lead flags from Autonomous all exist: `--version`, `--mode`, `--cwd`, `--resume`, `--continue`, `--model`, `--provider`, `--thinking`, `--approval-mode`, `--append-system-prompt`, `--config`, `--tools`, `--profile`.

What the app needs:

| Need | Flag | Evidence |
| --- | --- | --- |
| Working folder | `--cwd <dir>` (also the process cwd) | Run in a pty with process cwd `work\proj` and `--cwd work\other`: the status line showed `...scratchpad\work\other`, and the session file header's `cwd` was `...\\work\\other` (screenshot-substitute `omp-cli/flags-cwd-model-append-prompt.screen.txt`). |
| Extra system prompt | `--append-system-prompt <text or file>` | `packages/coding-agent/src/system-prompt.ts`, `resolvePromptInput`: if the value contains a newline it is the literal text; otherwise it is tried as a file path and, if readable, the **file's contents** are used; if the file is missing it falls back to the literal text (`catch { return input }`). It appends to the default coding-assistant prompt. `--system-prompt` replaces the default instead; `--system-prompt-template` takes a Handlebars file. `--append-system-prompt "Be terse."` was accepted in a pty launch with no error (the effect on the prompt is not visible without a turn). |
| Length on Windows | Command line limit | The Windows `CreateProcess` limit is 32,767 UTF-16 characters for the whole command line (platform fact, not measured with `omp`). A single-line value that is a file path avoids it; use an absolute path (the file is opened relative to the process cwd, which `--cwd` does not change). |
| Model | `--model <pattern>` or `provider/id` | `omp ... --model anthropic/claude-opus-5-5` started and the status line showed `Opus 5.5`; the session file recorded `{"type":"model_change",...,"model":"anthropic/claude-opus-5-5"}`. Fuzzy names (`opus`) are allowed; with a provider the id must be exact. Signed out the model cannot be used: see below. `--thinking <off|minimal|low|medium|high|xhigh|max|auto>` is recorded the same way (`thinking_level_change`, `high` by default). |
| First prompt | **Positional argument**, `omp "text"` | `docs/cli-reference.md` (launch): "Positional arguments become the initial message(s)"; the first goes in the opening turn, later ones are sent as later turns; `@file` attaches a file or image; `--` ends flags. Observed signed out: `omp --cwd ... --model anthropic/claude-opus-5-5 --append-system-prompt "Be terse." "say hi"` painted `Error: No API key found for anthropic.` and left `say hi` in the input box (it wrote a `draft.txt` containing `say hi` and a `.draft-only-session` marker next to the session file). No model request was made. |
| Approvals | `--approval-mode always-ask\|always-ask-cached\|write\|yolo`, `--auto-approve` | In `--help`. Not exercised. |
| One-run settings | `--config <file>` (repeatable) | See 8 and 10. |

A pty launch of the exact app shape (`omp` with no flags, `TERM=xterm-256color`, `COLORTERM=truecolor`) is `omp-cli/signed-out-main-tui.screen.txt`.

Other launch behavior seen:

```
$ omp --bogus-flag            (pty)          Error: unknown flag: --bogus-flag
                                             Run `omp --help` for available flags.      exit 2
$ omp --resume <no such id>   (pty)          see 4                                      exit 1
$ omp --resume ... </dev/null (no pty)       Error: interactive mode requires a terminal, but stdin is not a TTY.
                                             Pass a prompt (`omp -p "…"`), pipe one on stdin, or use `--mode rpc`.      exit 2
$ omp --bogus-flag  (stdin is a pipe)        Reading prompt from piped stdin (waiting for EOF; Ctrl+C to abort)…   (hangs; timeout 124)
```

So the TUI needs a real pty (the app has one), and a non-TTY stdin is read as the prompt.

## 4. Sessions

- **Id is minted by OMP; it cannot be chosen up front.** `packages/coding-agent/src/session/session-manager.ts` line 147: `export function mintSessionId(): string { return Bun.randomUUIDv7(); }`. No `--session-id` flag exists (`flag-tables.ts` lists every string flag). `--provider-session-id` only reuses a provider-side id for cache scoping. Format: UUIDv7, e.g. `01a19f51-856e-7612-8d38-0de416901104` (observed).
- **Storage:** `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. Observed file: `C:\Users\davgo\.omp\agent\sessions\-tmp-claude-5b27...-scratchpad-work-other\2026-11-03T02-51-22-350Z_01a19f51-856e-7612-8d38-0de416901104.jsonl` (884 bytes). The folder name encodes the canonical cwd (`session-paths.ts`: under home `-<relative>` with `/ \ :` replaced by `-`; under the temp root `-tmp-<relative>`; elsewhere `--<absolute>--`). `--session-dir <dir>` (or `PI_CODING_AGENT_SESSION_DIR`) relocates it, so the app could give each chat its own session dir and read the single new file. The file starts with a 256-byte `type:"title"` slot (current format), then the header line:

```json
{"type":"session","version":3,"id":"01a19f51-856e-7612-8d38-0de416901104","timestamp":"2026-11-03T02:51:22.350Z","cwd":"C:\\Users\\davgo\\AppData\\Local\\Temp\\claude\\5b2748231b82b70c\\46f2df57-16a2-475c-9c1e-531c9afb4fd7\\scratchpad\\work\\other"}
{"type":"model_change","id":"f6413948","parentId":null,"timestamp":"2026-11-03T02:51:22.437Z","runtime":{"version":"18.16.0"},"model":"anthropic/claude-opus-5-5","resolvedModelIsFallback":false}
{"type":"thinking_level_change","id":"f0154ba7","parentId":"f6413948","timestamp":"2026-11-03T02:51:22.437Z","runtime":{"version":"18.16.0"},"thinkingLevel":"high","configured":null}
```

- **When the file appears:** a launch with no prompt (`omp`, `omp --continue`) wrote **no** session file in three runs (only the folder for the cwd, in the first). A launch with a positional prompt wrote the file at once. So with no prompt the session is lazy (`docs/session.md`: "an initially created, lazy session whose JSONL file does not exist yet") and the id is not on disk until the first turn. The app can learn the id from the new `*_<uuid>.jsonl` name in the session dir, from `PI_SESSION_ID` / `PI_SESSION_FILE` (set only for the agent's own `bash` tool: `docs/environment-variables.md`), or from `omp session lease --json -- <id>...` (which of these ids a running `omp` holds).
- **Resume a given session:** `omp --resume <id-prefix | filename-prefix | path to .jsonl>` (also `--session <value>`). Matching is case-insensitive on the id prefix (`docs/session-operations-export-share-fork-resume.md`, "CLI `--resume <value>`"). Tested: `omp --resume 01a19f51` (a prefix) in the session's folder re-opened it; the draft text `say hi` came back in the input box, header unchanged, no new session file.
- **Missing session:** a clean error and **exit code 1**, no new session, no prompt (pty runs):

```
$ omp --resume 019c625b-b900-7000-8000-000000000001
Error: Session "019c625b-b900-7000-8000-000000000001" not found.
Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.
exit {"exitCode":1}

$ omp --resume C:/nonexistent/x.jsonl
Error: Session "C:/nonexistent/x.jsonl" not found.
Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.
exit {"exitCode":1}
```

  If the session exists but its recorded folder is gone, an interactive launch asks `Move (re-root) it into the current directory? [Y/n]` (source, not reproduced). `--resume` with no value opens a picker; `--continue` resumes the most recent session in the cwd and, when there is none, **silently starts a new one** (observed in a fresh folder: normal welcome screen, no error, process kept running).
- `--restore <id>` additionally continues an interrupted turn and its subagents; `--fork <id>` copies a session into a new id.

## 5. Sign-in

Non-interactive status commands, signed out (no credentials; run from `~`):

```
$ omp usage
No credentials found. Run `omp` and use /login to add accounts.      <- stderr; stdout is empty (0 bytes)
exit=1

$ omp usage --json
{
  "generatedAt": 1793674471240,
  "reports": [],
  "accountsWithoutUsage": [],
  "disabledCredentials": [],
  "capacity": {}
}
exit=0

$ omp token anthropic
No active credential found for provider "anthropic".
exit=1

$ omp models --json
{"models":[]}
exit=0

$ omp auth export
{
  "version": 1,
  "credentials": []
}
exit=0
```

- **Recommended status probe:** `omp models --json` or `omp usage --json` (both exit 0 signed out; a signed-out account has no model list or report). `omp usage` text exits 1 only when no credential is stored (`usage-cli.ts` line 1736-1739, after `process.stderr.write(...)`). `omp usage` fetches live provider usage over the network when signed in, so it is slower. Do not use `omp token <provider>` or `omp auth export` as a probe: signed in they print the secret token or every stored credential.
- **Signed-in `omp usage --json` re-recorded for DM-441 (omp 18.18.0, Windows 11, 2026-11-07 04:25:25–04:25:26 UTC).** The installed binary at `%LOCALAPPDATA%\omp\omp.exe` ran five times in sequence from this ticket's worktree using the person's existing sign-in. No login, logout, token command, credential export, or model turn was invoked. Both Anthropic and OpenAI Codex accounts appeared in `reports`. Exit code **0**, empty stderr, and **4136 stdout bytes before redaction** on each run. Wall times (process spawn through exit, rounded milliseconds): **723, 165, 165, 163, 162 ms; maximum 723 ms**. `fetchedAt` stayed identical per provider across all five runs, so the later runs used the same reports; this is not five independent cold-network fetches. The first Anthropic `fetchedAt` fell inside the first run; the Codex report predated it. Cache expiry and worst-case network latency were not measured. The earlier DM-438 recording (18.16.0, Anthropic, 2026-11-05) measured **772, 177, 180, 183, 180 ms**, all exit 0. The first current recording follows: only `metadata.accountId`, `email`, `orgId`, and `orgName` are replaced with `<redacted>`; no raw output or account identifiers were saved.

```
$ omp usage --json
{
  "generatedAt": 1794025525742,
  "reports": [
    {
      "provider": "anthropic",
      "fetchedAt": 1794025525433,
      "limits": [
        {
          "id": "anthropic:7d",
          "label": "Claude 7 Day",
          "scope": {
            "provider": "anthropic",
            "windowId": "7d",
            "shared": true
          },
          "window": {
            "id": "7d",
            "label": "7 Day",
            "durationMs": 604800000,
            "resetsAt": 1794261599965
          },
          "amount": {
            "used": 12,
            "limit": 100,
            "remaining": 88,
            "usedFraction": 0.12,
            "remainingFraction": 0.88,
            "unit": "percent"
          },
          "status": "ok"
        },
        {
          "id": "anthropic:7d:fable",
          "label": "Claude 7 Day (Fable)",
          "scope": {
            "provider": "anthropic",
            "windowId": "7d",
            "tier": "fable"
          },
          "window": {
            "id": "7d",
            "label": "7 Day",
            "durationMs": 604800000,
            "resetsAt": 1794261600000
          },
          "amount": {
            "used": 0,
            "limit": 100,
            "remaining": 100,
            "usedFraction": 0,
            "remainingFraction": 1,
            "unit": "percent"
          },
          "status": "ok"
        }
      ],
      "metadata": {
        "endpoint": "https://api.anthropic.com/api/oauth/usage",
        "accountId": "<redacted>",
        "email": "<redacted>",
        "orgId": "<redacted>",
        "orgName": "<redacted>"
      },
      "resetCredits": {
        "availableCount": 0,
        "redeemableCount": 0,
        "eligible": false,
        "reason": "not_at_wall",
        "credits": []
      }
    },
    {
      "provider": "openai-codex",
      "fetchedAt": 1794025383969,
      "limits": [
        {
          "id": "openai-codex:primary",
          "label": "7 days",
          "scope": {
            "provider": "openai-codex",
            "windowId": "7d",
            "shared": true
          },
          "window": {
            "id": "7d",
            "label": "7 days",
            "durationMs": 604800000,
            "resetsAt": 1794627590000
          },
          "amount": {
            "used": 0,
            "limit": 100,
            "remaining": 100,
            "usedFraction": 0,
            "remainingFraction": 1,
            "unit": "percent"
          },
          "status": "ok"
        }
      ],
      "resetCredits": {
        "availableCount": 2,
        "credits": [
          {
            "grantedAt": "2026-10-31T20:29:44.237380Z",
            "expiresAt": "2026-11-30T20:29:44.237380Z",
            "status": "available"
          },
          {
            "grantedAt": "2026-11-01T23:00:00.507246Z",
            "expiresAt": "2026-12-01T23:00:00.507246Z",
            "status": "available"
          }
        ]
      },
      "metadata": {
        "planType": "prolite",
        "allowed": true,
        "limitReached": false,
        "email": "<redacted>",
        "accountId": "<redacted>",
        "meterStates": {
          "chat": {
            "allowed": true,
            "limitReached": false
          }
        },
        "orgId": "<redacted>",
        "orgName": "<redacted>"
      }
    }
  ],
  "accountsWithoutUsage": [],
  "disabledCredentials": [],
  "capacity": {
    "anthropic": [
      {
        "window": "7d",
        "durationMs": 604800000,
        "accounts": 1,
        "usedAccounts": 0.12,
        "remainingAccounts": 0.88
      },
      {
        "window": "7d",
        "durationMs": 604800000,
        "meter": "fable",
        "accounts": 1,
        "usedAccounts": 0,
        "remainingAccounts": 1
      }
    ],
    "openai-codex": [
      {
        "window": "7d",
        "durationMs": 604800000,
        "meter": "chat",
        "accounts": 1,
        "usedAccounts": 0,
        "remainingAccounts": 1
      }
    ]
  }
}
exit=0
```

  The source reading held: non-empty `reports` (now two provider accounts, with `limits[]`, `metadata` and `resetCredits`) means signed in; `accountsWithoutUsage` and `disabledCredentials` stayed empty. No `classifyOmp` change is needed. Keep `STATUS_TIMEOUT_MS.omp` at **10,000 ms**, covering the slowest recording across both five-run samples (**772 ms**) with **9228 ms** margin. This margin comes from the measured runs and inspection of the existing source timeout, not a simulated timing test. The existing signed-in behavioral regression in `agentAuth.test.ts` uses this exact redacted 18.18.0 recording. `omp models --json` signed in was not recorded.

  **Desktop smoke (DM-441):** the real `electron-vite dev` app used isolated `--user-data-dir=%TEMP%/dm-441-desktop-profile` and remote-debug port 9441, with the installed CLI chosen through its native Find picker. The Skitarii card and sidebar both showed **Signed in** (v18.18.0). A read-only `window.dm.agentStatus('omp')` call through the actual preload/main bridge returned `{state: "signed_in", reason: "Skitarii reports it is signed in."}` in **164 ms**, inside the 10 s timeout. Screenshot captured from that Electron surface: `%TEMP%/dm-441-skitarii-signed-in.png` (handed to the orchestrator for the card's evidence attachment). No real app profile was changed.
- **Interactive login:** `omp login [PROVIDER]` (`omp login anthropic`; omit PROVIDER to pick). `omp login --help`:

```
Log in to a model provider (terminal counterpart of /login)

USAGE
  $ omp login [PROVIDER]

ARGUMENTS
  PROVIDER   OAuth provider id (e.g. anthropic, openai-codex); omit to pick interactively
```

  Inside the TUI the same is `/login`. API-key sign-in via environment variables (`ANTHROPIC_API_KEY` and others, listed at the end of `omp --help`) also works.
- **Store:** `~/.omp/agent/agent.db` (SQLite; exists, 188 KB, after my runs, with no credentials). It matches the Autonomous report. `--profile <name>` moves auth, sessions and settings to `~/.omp/profiles/<name>/agent`; `PI_CODING_AGENT_DIR` relocates the agent dir for the default profile.
- **First launch is not the main screen.** A signed-out first run of plain `omp` opens a five-step **Setup** wizard (`omp-cli/signed-out-first-launch-setup.screen.txt`: "Setup step 1 of 5 / Sign in to your providers", a provider picker; step 5 is "Pick a theme"). Escape skips a step. Finishing or skipping all of them writes `setupVersion: 2` to `~/.omp/agent/config.yml`; later launches go straight to the main TUI (`omp-cli/signed-out-main-tui.screen.txt`, with `Warning: No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.`). The app should run `omp` once itself, or write `setupVersion: 2` through a `--config` overlay, so a chat does not open on the wizard (not tried as an overlay).
- `agent.db` holds the sign-in only for the agent dir. A launch with another `PI_CODING_AGENT_DIR` or `--profile` is signed out.

## 6. Instruction files and MCP

Source: `docs/context-files.md`; **not exercised** (no model, and the system prompt is not printed anywhere I could reach without a turn).

- **AGENTS.md: yes.** Project files via the `agents-md` provider: `AGENTS.md` found by walking up from the cwd to the repository root (and enclosing workspace dirs below home). Native `.omp/AGENTS.md` (nearest non-empty `.omp/`) and `~/.omp/agent/AGENTS.md` for the user.
- **CLAUDE.md: yes, project level.** Standalone `CLAUDE.md` through the `claude-md` provider (same walk-up) and `<cwd>/.claude/CLAUDE.md`. User-level `~/.claude/CLAUDE.md` is opt-in (`enabledProviders: [claude]`). `--no-context-files` turns all of it off.
- **MCP: yes.** `.omp/mcp.json` (project), `~/.omp/agent/mcp.json` (user), plus imports from `.mcp.json`, `~/.claude.json`, Codex, Gemini and others (`docs/mcp-config.md`). Chats do not need it: they use the `dm` CLI with `DM_SESSION_TOKEN`, which the agent runs through its `bash` tool.

## 7. TUI terminal needs

Environment detection (`packages/tui/src/terminal-capabilities.ts`): `detectTerminalId` picks a known terminal from `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, `WEZTERM_PANE`, `ITERM_SESSION_ID`, `VSCODE_PID`, `ALACRITTY_WINDOW_ID`, `TERM_PROGRAM`, `LC_TERMINAL`, `TERM`; otherwise `COLORTERM=truecolor|24bit` gives the generic `trueColor` profile, and anything else is `base`. **The app sets only `TERM=xterm-256color` and `COLORTERM=truecolor`, so `omp` sees the generic `trueColor` profile**: true color on, hyperlinks off, no image protocol, no DECCARA, sync output off until probed. Windows Terminal sets `WT_SESSION`, which turns on true color (`detectColorMode`) and synchronized output (`shouldEnableSynchronizedOutputByDefault`, rule 3) without a probe. The `TerminalInfo` for `trueColor` is `new TerminalInfo("trueColor", null, true, false, NotifyProtocol.Bell)`.

What `omp` emits and expects, with the evidence:

| Feature | Behavior | Evidence |
| --- | --- | --- |
| Color | True color (`38;2;r;g;b`) by default; 256 and 16 via `Bun.color` by mode. Present in a capture without `COLORTERM` too. | pty capture (`38;2;` found in all runs). |
| Alternate screen | **Not used for the main TUI** (it paints in the normal buffer and keeps scrollback). `?1049h` is used for fullscreen overlays and resize handling. | Source `tui.ts` lines 2091, 3932. Captured: `?1049` appeared once in the run where I pressed Escape repeatedly (an overlay), not in plain launches. |
| Bracketed paste | Enabled: `\x1b[?2004h`, re-asserted often (127 times in 12 s of the first-run wizard). Expects `\x1b[200~...\x1b[201~`. | Captured; `terminal.ts` line 1213. |
| Synchronized output (DEC 2026) | Wraps frames in `\x1b[?2026h ... \x1b[?2026l` **only when enabled**: by `WT_SESSION`, `TERM_FEATURES` containing `Sy`, a known terminal, `PI_FORCE_SYNC_OUTPUT=1`, or when the DECRQM probe `\x1b[?2026$p` reports support. Off by default for the app's `trueColor` profile. | `terminal-capabilities.ts` lines 266-345; `terminal.ts` line 1284. Not seen in the ConPTY capture (no probe reply came back). |
| Cursor | Hides and shows with `?25l` / `?25h` (39 and 38 times); resets with `\x1b[0 q` on exit. | Captured. |
| Keyboard | Probes the kitty keyboard protocol (`\x1b[?u`; pushes `\x1b[>5u` or `>7u` on a reply). With no kitty reply it falls back: on **Windows ConPTY it enables win32-input-mode `\x1b[?9001h`** and decodes `CSI ... _` records, passing plain VT through; elsewhere modifyOtherKeys `\x1b[>4;2m`. Also `\x1b[?1l\x1b>` (normal cursor keys). Shift+Tab is `\x1b[Z`. Shift+Enter and Ctrl+Enter need one of these modes to be told from Enter. | `terminal.ts` lines 1225, 1635-1665, 2090-2118. Captured: `?9001h` once, `\x1b[?u` once. |
| Mouse | **Off in the main view** (`tui.mouse` default `false`). Fullscreen overlays turn on `?1000h ?1003h ?1006h` (SGR). | `docs/settings.md` line 905; capture of the wizard showed `1000`, `1003`, `1006` toggles. |
| Focus events | `\x1b[?1004h`. | Captured. |
| OSC 8 hyperlinks | Written only when `shouldEnableHyperlinksByDefault` says so: **off** for the `trueColor` and `base` profiles, on for known terminals (kitty, ghostty, wezterm, iterm2, vscode, alacritty...), `PI_FORCE_HYPERLINKS=1` forces on, `PI_NO_HYPERLINKS=1` off. | `terminal-capabilities.ts` lines 420-470. |
| OSC 52 clipboard | Writes `\x1b]52;<sel>;<base64>\x07` for copy (the terminal's own writer logs `\x1b]52;...<N bytes>`); needs the terminal to honor it. | `terminal.ts` lines 139, 2573. Not exercised. |
| Title | OSC 0: `\x1b]0;π > <folder>\x07` observed (`π > proj`, `π > other`, `π > proj3`). Extensions can replace it. | Captured. |
| Run status | **OSC 7501** (Program Status Protocol): `\x1b]7501;state=idle:app=omp` at idle; states `idle`, `working`, `blocked` (with `kind`, `msg`), `done`, `error`. `terminal.programStatus` setting turns it off. This is a ready-made signal for whether the agent is working or waiting, readable from the PTY stream. | Captured at idle; `packages/coding-agent/src/utils/run-status.ts`. |
| Other private modes | `?2031h` (appearance-change notifications, replies `\x1b[?997;1\|2n`), `?5522h` (enhanced paste), `\x1b[22;2t` (push title), `\x1b[?2;1;0S`. | Captured. |
| Startup probes (queries `omp` sends and waits on) | OSC 11 `\x1b]11;?\x07` (background color, for dark/light), DA1 `\x1b[c` as sentinel after each probe, OSC 99, the Glyph Protocol query, TSP hello, DECRQM `\x1b[?<mode>$p`, kitty `\x1b[?u`. Each probe ends in a DA1 so a terminal that ignores it does not stall. The app's xterm.js answers DA1 and OSC 11 only if configured; unanswered probes are expected to time out (not measured). | `terminal.ts` lines 1832-1992, 2153-2170. The headless xterm saw no replies to send because ConPTY consumed these queries. |
| Unicode width | Grapheme-segmented (`Intl.Segmenter`) with its own width table (`utils.ts` `visibleWidth`), so wide glyphs and emoji count as 2 cells in its layout. Hangul Jamo width is per terminal; the app's profile uses "platform". The banner and status line use box-drawing, block elements and `π ⬢ ◫ ⟲ ▶` and `🗑`. The terminal must draw those with the same width or rows will wrap. Not tested for mismatch. | `terminal-capabilities.ts` (`hangulJamoWidth`), `utils.ts` lines 252-360; capture rows. |
| Inline images | Kitty graphics, iTerm2 OSC 1337, SIXEL: see 10. None for the `trueColor` profile. | see 10. |
| Cursor placement / redraw | Differential renderer, at most one frame per `1000/30` ms (about 33 ms), with an adaptive floor of up to 200 ms when frames are slow. | `tui.ts` lines 949-957, 2888. Measured: see "Redraw" in 10. |

Captured private-mode set, ConPTY-forwarded, in the plain main launch (`omp`, 120x30): `?1 ?25 ?1004 ?2004 ?2031 ?5522 ?9001`, plus `?1000 ?1003 ?1006 ?1049` in the run that opened wizard overlays. Total CSI/OSC counts for the first-run wizard (12 s): 70,754 SGR, 4,768 CUF (`C`), 4,620 ECH (`X`), 2,309 EL (`K`) and 172 CUP (`H`) sequences in 1.4 MB: the animated logo uses cursor-forward and erase-character heavily.

## 8. Theme

- **Active theme setting:** `theme.dark` and `theme.light` (two auto slots chosen by the terminal's background luminance: OSC 11, then `COLORFGBG`, then dark), plus `symbolPreset` and `colorBlindMode`, in the global config `~/.omp/agent/config.yml` (YAML). Defaults (`packages/coding-agent/src/modes/settings.ts`): `theme.dark = titanium`, `theme.light = light`, `symbolPreset = unicode`.

```
$ omp config get theme.dark
titanium
$ omp config path
C:\Users\davgo\.omp\agent
```

- **Theme files:** custom themes are JSON in `~/.omp/agent/themes/<name>.json` (`getCustomThemesDir`; `$PI_CODING_AGENT_DIR/themes` with that override; `~/.omp/profiles/<name>/agent/themes` for a profile). Built-ins (about 100: `titanium`, `dark`, `light`, `dark-nord`, `dark-synthwave`, `light-paper`, ... from `packages/tui/src/theme/defaults.json`) are embedded and win over a same-named file.
- **Format** (`docs/theme.md`, `packages/tui/src/theme/theme-schema.json`): `name` (required), `vars` (optional named colors), `colors` (68 keys, 66 required, listed in 10), `symbols` (optional: `preset`, `overrides`, `spinnerFrames`), `export` (optional). A color value is `"#RRGGBB"`, a 0-255 integer (256-color index), a `vars` name, or `""` (terminal default). The probe theme I used, which validated and loaded: [`omp-cli/probe-theme.json`](omp-cli/probe-theme.json). Excerpt:

```json
{
 "name": "skitarii-test",
 "vars": { "accent": "#7aa2f7", "muted": 244 },
 "colors": { "accent": "#ff0033", "statusLineBg": "#003300", "statusLineModel": "#ff0033", "text": "", "...": "all other keys, 66 required" },
 "symbols": { "spinnerFrames": { "status": ["<1>","<2>","<3>"], "activity": ["a","b"] } }
}
```

## 9. Smoke in the app

**How it was run.** In this worktree: `npm ci`, then `node node_modules/electron/install.js` (the Electron binary was not fetched by `npm ci` here), then `npm run build` (electron-vite, passed). node-pty uses its N-API prebuilds (`npmRebuild: false`), so no native rebuild. The build was launched as `node_modules\electron\dist\electron.exe . --user-data-dir=<scratchpad>\dm-userdata --remote-debugging-port=9333 --inspect=9339` with `DISABLE_AUTO_UPDATE=1` (and `ELECTRON_RUN_AS_NODE` removed from the environment, which my shell had set and which makes Electron exit at once). The person's `%APPDATA%\dark-mechanicus` and installed app were not used. The renderer was driven over CDP (clicks in the page), the window set to 1280x800 content, display scale 1.5.

- **Native dialogs were stubbed, not clicked.** Over the main process inspector I replaced `dialog.showOpenDialog` (returns the scratch folder for a folder pick, `C:\Users\davgo\AppData\Local\omp\omp.exe` for a file pick) and `dialog.showMessageBox` (returns `{response: 0, checkboxChecked: true}`), and logged the options the app passed. The app's own code ran everything else. Logged confirmation: title `Add a custom CLI`, message `Run this command and save it as "OMP"?`, detail `Program: C:\Users\davgo\AppData\Local\omp\omp.exe … Arguments: none`.
- Steps: **Choose folder** (scratch git repo `omp-scratch` under the scratchpad, one commit), **Initialize folder** (defaults, which include writing `.mcp.json`), **Add an agent**, **Add a custom CLI**, Name `OMP`, no arguments (the chat terminal's cwd is already the folder, `terminalLaunchSpec.ts` `cwd: input.folder`), **Choose executable…**. The card said `Connected OMP`; the sidebar says `OMP · Version unknown · Sign-in not checked`. **New chat in omp-scratch** opened a chat at once: `OMP · Terminal · RUNNING · Orchestrator · Allowed to save plans`. Process list: `omp.exe` with command line `C:\Users\davgo\AppData\Local\omp\omp.exe`, a child of the Electron main process.
- The pane's grid, read from `omp.exe`'s own console (`AttachConsole` + `GetConsoleScreenBufferInfo`), was **147x42**. Windows Terminal was then opened as `wt.exe -w new --size 147,42 -d <omp-scratch> C:\Users\davgo\AppData\Local\omp\omp.exe` (no other Windows Terminal was running), and its `omp.exe` console read **147x42** too. That window alone was captured with `PrintWindow(hwnd, PW_RENDERFULLCONTENT)`.
- Both runs were signed out and the first-run wizard did not appear (`setupVersion: 2`). Both connected to the `darkmechanicus` MCP server from the `.mcp.json` that **Initialize folder** wrote (it starts `node out\main\mcp.js --repo <omp-scratch> --role orchestrator --allow-save`).
- Afterwards the Windows Terminal window, both `omp.exe` and both MCP `node.exe` children, and the test app (closed with a normal `taskkill /PID`, no `/F`) were gone; no process from this run was left.

Screenshots:

- [`omp-cli/app-pane-omp-tui.png`](omp-cli/app-pane-omp-tui.png): CDP page capture of the app, chat pane on the right (1920x1200 device pixels).
- [`omp-cli/windows-terminal-omp-tui.png`](omp-cli/windows-terminal-omp-tui.png): window capture of the Windows Terminal window only (2130x1272).

The ConPTY text dumps from before stay as the byte-level record: [`omp-cli/signed-out-first-launch-setup.screen.txt`](omp-cli/signed-out-first-launch-setup.screen.txt), [`omp-cli/signed-out-main-tui.screen.txt`](omp-cli/signed-out-main-tui.screen.txt), [`omp-cli/flags-cwd-model-append-prompt.screen.txt`](omp-cli/flags-cwd-model-append-prompt.screen.txt), [`omp-cli/theme-and-extension-probe.screen.txt`](omp-cli/theme-and-extension-probe.screen.txt).

**Same in both (observed):** logo with its true-color gradient and the dithered shade cell, `v18.16.0`, the orange `Warning: No default model selected…` line, `Connected to MCP server: darkmechanicus.`, the status line `π > ⬢ no-model > 🗑 …\scratchpad\omp-scratch > ⑂ master ?2 > ◫ 14K/? ⟲` with its rule to the right edge, `⇧⇥ to change thinking effort` right-aligned, and the input corner `╰`. Same layout and wrap at 147 columns; no row wrapped or shifted in either. Both used the dark theme slot (same text and status-line colors; the status-line band is `#101216` in the app and `#0F1216` in Windows Terminal, sampled pixels).

**Visible differences (observed in the two captures):**

1. **Default background:** the app pane is `#0F0D0C` (the app's terminal theme), Windows Terminal `#0C0C0C` (its default scheme). OMP draws no background of its own outside the status band, so the terminal's shows through.
2. **Cursor:** the app pane shows a filled amber block cursor; Windows Terminal shows a thin bar. This is each terminal's own cursor style; OMP did not set one at idle.
3. **Font and cell size:** the app uses IBM Plex Mono 13 px (`--font-mono`); Windows Terminal its profile font (Cascadia Mono). Same grid, different glyph shapes and weight; the app's text is denser.
4. **Wide or symbol glyphs in the status line:** `🗑` is a narrow monochrome outline in the app pane and a gray hatched color-emoji bin in Windows Terminal; `⬢` is larger and rounder in the app; `◫` is drawn heavier in the app. Neither misaligned the following text.
5. **Title:** Windows Terminal shows OMP's OSC 0 title `π > omp-scratch` in its tab. The app pane does not show it; its header reads `New chat` and the sidebar `New chat · OMP · Default model`.
6. **Tip line:** the tip differs (`Psst, omp has a natural habitat <emoji>tern (https://scl.so/tern)` in the app, `Press ←← to drill into …` in Windows Terminal, wrapped over two rows). OMP picks a random tip per launch, so this is not a terminal difference. The app's URL is plain text (no OSC 8 underline), as 7 predicts; Windows Terminal's tip had no link to compare.

**Not checked (still predictions from 7 and 10):** synchronized output (DEC 2026) and frame tearing during the logo animation (the captures are idle frames); whether xterm.js answers DECRQM and OSC 11 (both landed on the dark slot, which is also the fallback); keyboard behavior (Shift+Enter, paste, resize) since no key was sent; OSC 52 copy; mouse in overlays; inline images (none drawn in either).

## 10. Customization surface (sprint 2, Skitarii styling)

### Theme per launch

- **No theme flag and no theme environment variable.** `omp --help` has none; `docs/environment-variables.md` lists no `OMP_THEME`; the only theme-related variables are the detection ones (`COLORTERM`, `TERM`, `WT_SESSION`).
- **Per-launch selection: `--config <file>`**, a `config.yml`-style YAML overlay "for this run only", repeatable, "never persisted", loaded after global and project settings (`docs/settings.md` lines 21, 125, 298-307); `PI_CONFIG_FILES` does the same through the environment (`;`-separated on Windows). Overlay used:

```yaml
# omp-cli/probe-overlay.yml
theme:
  dark: skitarii-test
```

- **Where the theme file has to live:** custom themes are read only from the themes dir (above). A theme file is **not** a per-launch input: it must be on disk in `~/.omp/agent/themes/` (a file the app would own; it does not change the person's `theme.dark` default, which the overlay overrides only for that process). The extension API cannot register a theme (`resources_discover` returns `themePaths` but nothing calls it: `docs/extensions.md` "resources_discover", `runner.ts` line 2169 vs no `AgentSession` caller), and `ctx.ui.setTheme(<name>)` accepts only a name (`extension-ui-controller.ts` lines 213-218: "Theme object passed directly - not supported"). Pointing `PI_CODING_AGENT_DIR` at a private folder would allow a private themes dir, but it also leaves `agent.db`, so the launch would be signed out.
- **Verified end to end** (scratch agent dir via `PI_CODING_AGENT_DIR`, so nothing in `~\.omp` changed; command from [`omp-cli/pty-capture.js`](omp-cli/pty-capture.js)):

```
PI_CODING_AGENT_DIR=<scratch>\agentdir  node pty-capture.js <out> 9000 120 30 <cwd> -- --config <scratch>\overlay.yml -e <scratch>\ext-test.ts
-> has 255;0;51 fg: True   bg 0;51;0: True
```

  The theme's `#ff0033` (`accent`, `statusLineModel`, `statusLinePath`) arrived as `38;2;255;0;51` and `statusLineBg` `#003300` as `48;2;0;51;0` in the byte stream, with `theme.dark: skitarii-test` set only by the overlay. `omp --config` is also accepted by `acp`, `models` and `dry-balance`.
- **Other per-launch appearance settings through the same overlay** (`docs/settings.md`): `symbolPreset` (`unicode`, `nerd`, `ascii`), `colorBlindMode`, `statusLine.preset` / `statusLine.separator` / `statusLine.transparent` / `statusLine.leftSegments` / `statusLine.rightSegments`, `composer.shape`, `startup.quiet` (suppresses the welcome and splash), `startup.showSplash`, `tui.mouse`, `terminal.programStatus`.

### Theme color keys (all 68; `colors` in `packages/tui/src/theme/theme-schema.json`; `assistantMessageText` and `thinkingMax` are optional)

```
accent border borderAccent borderMuted success error warning muted dim text assistantMessageText thinkingText
selectedBg userMessageBg userMessageText customMessageBg customMessageText customMessageLabel
toolPendingBg toolSuccessBg toolErrorBg toolTitle toolOutput
mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet
toolDiffAdded toolDiffRemoved toolDiffContext
syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation
thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode pythonMode
statusLineBg statusLineSep statusLineModel statusLinePath statusLineGitClean statusLineGitDirty statusLineContext
statusLineSpend statusLineStaged statusLineDirty statusLineUntracked statusLineOutput statusLineCost statusLineSubagents
```

`symbols.spinnerFrames` takes a flat array or `{ "status": [...], "activity": [...] }`: `status` drives the loader and tool-execution spinner at about 12.5 fps, `activity` a roughly 30 fps spinner for progress UI (`docs/theme.md` line 90; `packages/tui/src/theme/symbols.ts` lines 1499-1530). Box-drawing, bullets and other glyphs are overridable through `symbols.overrides` (`SymbolKey`).

### Extension API: load path, per-launch enable, what it can draw

- **Per launch:** `-e, --extension <file>` (repeatable; `--hook` is treated the same; `--no-extensions` disables discovery but explicit `-e` still loads: `docs/extension-loading.md`). An extension is a TS/JS module with a default factory, `export default function (pi: ExtensionAPI) {...}`, loaded by the compiled binary directly (a `.ts` file worked). Discovery without a flag: `~/.omp/agent/extensions/`, `.omp/extensions/`, plugins, `extensions:` in config (`docs/extension-loading.md`). `--trusted-extension <absolute path>` is the allowlist form and cannot be combined with `-e`.
- **Verified** with [`omp-cli/probe-extension.ts`](omp-cli/probe-extension.ts) via `-e` in a pty: the screen model afterwards ([`omp-cli/theme-and-extension-probe.screen.txt`](omp-cli/theme-and-extension-probe.screen.txt)) contained `EXT-LOADED notify`, `WIDGET-LINE-1` and `WIDGET-LINE-2` above the editor, and `STATUS-PROBE-TEXT` below it, and the byte stream held `\x1b]0;SKITARII-TITLE`. `HEADER-PROBE` (from `setHeader`) never appeared.
- **What an extension can draw in the interactive TUI** (`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` `initHooksAndCustomTools`; `docs/extensions.md` lines 923-957):

| Surface | API | Interactive result |
| --- | --- | --- |
| Welcome banner / header | `ctx.ui.setHeader(factory)` | **No-op**: the controller sets `setHeader: () => {}` (line 225); confirmed by the probe. The `omp` logo block and version are built in (`startup-composer.ts`, `ComposerWelcomeUpdate { version }`); the only switch is `startup.quiet` (hide) or `startup.showSplash`. No setting renames or replaces the logo. |
| Footer | `ctx.ui.setFooter(factory)` | **No-op** (line 224). |
| Status line text | `ctx.ui.setStatus(key, text)` | Works; drawn on a row under the editor (probe: `STATUS-PROBE-TEXT`). Shown only if the `status` segment is in the status line segments and `statusLine.showHookStatus` is on (default). |
| Status line segments and colors | settings `statusLine.*`, theme `statusLine*` keys | Config and theme, not extension API. Brand segment `pi` renders `π` (`π-<profile>` with a named profile). |
| Working indicator text | `ctx.ui.setWorkingMessage(text)` or `setWorkingMessage()` to restore | Sets the label shown while a turn streams; the default is `Working…` (`interactive-mode.ts` line 521). Source only: no turn could be started. |
| Working indicator frames | theme `symbols.spinnerFrames` | Source only (theme loader normalizes it); not observed. |
| Widgets | `ctx.ui.setWidget(key, string[] \| component, { placement: "aboveEditor" \| "belowEditor" })` | Works (probe). Strings show up to 10 lines. |
| Terminal title | `ctx.ui.setTitle(text)` | Works (probe: `\x1b]0;SKITARII-TITLE`). It then owns the title until cleared. Default is `π > <folder>`. |
| Notices | `ctx.ui.notify(text, "info"\|"warning"\|"error")` | Works (probe). |
| Custom components, overlays, dialogs | `ctx.ui.custom(factory)`, `select`, `confirm`, `input`, `editor` | Supported (`packages/tui` `Component { render(width): string[] }`). |
| Input box | `ctx.ui.setEditorComponent(factory)` (must return a `CustomEditor`), `pi.registerComposerShape({ label, description, style })` | Supported. A composer shape is a `ComposerStyle` with `renderTop`, `renderRow`, `renderBottom` and layout fields (`docs/extensions.md` lines 1222-1295). |
| Message rendering | `registerMessageRenderer`, `registerAssistantThinkingRenderer`, `registerAssistantTextRenderer` (opt-in setting `extensionRenderers.assistantText`, default off), tool `renderCall` / `renderResult` | Supported. |
| App name | none | "omp" and "π" are fixed strings; no setting or API renames them. The title can be changed. |
| Theme | `ctx.ui.setTheme(name)`, `getAllThemes()`, `getTheme(name)` | By name only. |

### Inline images

**Yes, `omp` can draw inline images, but not in the app's current terminal profile.** `packages/tui/src/components/image.ts` has an `Image` component; `terminal-capabilities.ts` defines `ImageProtocol { Kitty, Iterm2, Sixel }` and picks one by terminal: kitty, ghostty, wezterm, warp, otty, rio, rex, tern and monstar get Kitty graphics, iterm2 gets OSC 1337, and `vscode` and `alacritty` get none; the `trueColor` and `base` profiles (what the app presents today) get none (`new TerminalInfo("trueColor", null, ...)`), except a runtime SIXEL probe may enable SIXEL where the terminal answers it. `PI_FORCE_IMAGE_PROTOCOL=kitty|iterm2|sixel|off` overrides, and `omp images` inspects and diagnoses the backends. An extension can mount an `Image` through `ctx.ui.custom`/widgets (not tried). Whether the app's xterm.js renders any of these needs an image addon and was not tested; **not observed**.

### Redraw rate for animation

- The renderer is capped at one frame per `1000/30` ms (about 33 ms, so about 30 fps) with an adaptive floor of up to 200 ms when frames are slow, and it stops composing while the terminal still owes a backlog (`packages/tui/src/tui.ts` lines 949-957, 2888, backpressure comment after it). Built-in spinners: about 12.5 fps (`status`) and about 30 fps (`activity`) per `docs/theme.md`.
- Measured by chunk count in a ConPTY capture: the welcome logo animation runs for about 3.5 s at about 40-85 output chunks per second and 8-27 KB/s (first-run wizard: up to 500 KB/s), then **idle output is zero**: in a 16 s run, seconds 3 onward carried 4 chunks and 32 bytes in total, 0 bytes after. So `omp` repaints only on change, never as an idle animation. A custom animation in an extension should stay at or below about 12 fps to keep the diff small, and every animated row must be re-sent whole (it is a diff renderer, so only changed rows are written).

## Open items for the next tickets

- A hands-on key test (Shift+Enter, paste, resize) and an animated-frame (DEC 2026) check in the app pane; item 9 covered idle frames only.
- Signed-in output of `omp models --json` (`omp usage --json` is recorded in section 5), and a real resume after a model turn (the session had no turn, only a draft).
- Whether xterm.js 6 answers DECRQM 2026 and OSC 11 (so frames are synchronized and the theme slot is right), and whether it can show Kitty graphics.
- AGENTS.md / CLAUDE.md pickup was read from docs only.
- Working-indicator text and spinner frames were read from source only.
