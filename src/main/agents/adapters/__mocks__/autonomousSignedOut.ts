/**
 * What the installed Autonomous 0.79.0 (OMP 18.11.2) says with no model sign-in, captured on 2026-10-30
 * (DM-307) with an isolated profile: a temporary HOME with every `XDG_*_HOME` inside it, started through
 * `env -i` with only PATH, HOME, the XDG variables, TMPDIR and the locale, so no credential variable and
 * none of the person's own sign-ins applied (there `a8s doctor` also found Okta, gh and Factory signed
 * out). Two profiles: a copy of the person's personal `profile.json` (no secret in it), the case of a
 * person who set a8s up and is signed out of the model; and none at all, a person who never ran
 * `a8s init`. Findings are in docs/reports/autonomous-acp.md ("Signed out").
 *
 * Sanitized: the temporary HOME and the install's home are `/Users/me`, and the install's version folder
 * hash is `<hash>`. Everything else is as a8s printed it. Not shipped.
 */

/** The lines `a8s doctor` printed before its profile checks, in both profiles. */
const DOCTOR_HEAD = [
  'a8s doctor',
  '  ✓ Node                    22.22.1',
  '  ✓ Bun                     1.4.2',
  '  ✓ git                     2.46.0',
  '  ✓ Python                  3.9.6',
  '  ✓ Release                 0.79.0 darwin-arm64 · OMP 18.11.2 · /Users/me/.local/opt/a8s'
]

/** The lines after `Model route`, in both profiles. */
const DOCTOR_TAIL = [
  '  ! Linear MCP              Optional connection is not signed in; model use is unaffected.',
  '      fix: Run /mcp add linear --scope user --url https://mcp.linear.app/mcp in a session to authorize.',
  '  ! Notion MCP              Optional connection is not signed in; model use is unaffected.',
  '      fix: Run /mcp add notion --scope user --url https://mcp.notion.com/mcp in a session to authorize.',
  '  ! Multiplayer             sign-in required for harness.eng.int.onebrief.tools',
  '                            fix: a8s setup',
  '  ! gh github.com           not signed in',
  '                            fix: gh auth login --hostname github.com',
  '  ! gh git.onebrief.tools   not signed in',
  '                            fix: gh auth login --hostname git.onebrief.tools',
  '  ✓ Usage export            sends to eng-signals-collector',
  '  ✓ MCP and company policy  Personal MCP: linear: disabled · user/onebrief-mcp · /Users/me/.local/opt/a8s.versions/0.79.0-<hash>/dist/omp/personal-mcp/defaults.js; Personal MCP: notion: disabled · user/onebrief-mcp · /Users/me/.local/opt/a8s.versions/0.79.0-<hash>/dist/omp/personal-mcp/defaults.js',
  '  ! Factory                 Factory CLI is not signed in',
  '                            fix: factory login',
  '  ! semgrep                 1.172.0 is not installed at /Users/me/.local/share/a8s/runtime/bin/semgrep yet',
  '      fix: Run a8s update --tools-only to repair the managed Semgrep installation.',
  '  ! Spud                    Spud CLI is missing required review options.',
  '                            fix: Run a8s setup to install the current Spud CLI.',
  '  ✓ Interface experience    built-in Autonomous',
  '  ✓ Captures                /Users/me/.local/state/a8s/captures · created on first session · 170 GiB free',
  '  ✓ Workspace               /Users/me/work',
  '  ✓ Updates                 0.80.0 (ca10df7d) downloaded; run a8s update',
  '1 problem, 10 warnings. a8s doctor --fix repairs permissions and the cached key.',
  ''
]

/** `a8s doctor` with the personal profile and no model sign-in: exit 1, a failed `Model route`. */
export const DOCTOR_SIGNED_OUT = {
  exitCode: 1,
  output: [
    ...DOCTOR_HEAD,
    '  ✓ Profile                 /Users/me/.config/a8s/profile.json · personal · key from $ONEBRIEF_MODEL_KEY, stored key',
    '  ! Gateway MCP             No gateway MCP clients are enabled in the profile.',
    '      fix: Configure mcp.enabledServers and mcp.connectors for the harness key.',
    '  - Oasis                   not enabled',
    '  ! Okta                    Onebrief company sign-in required',
    '                            fix: a8s login',
    '  ✗ Model route             Claude subscription is not ready',
    '                            fix: a8s init --force',
    ...DOCTOR_TAIL
  ].join('\n')
}

/** `a8s doctor` with no profile (never set up) and no model sign-in: exit 1 (the missing profile), a warning `Model route`. */
export const DOCTOR_NO_PROFILE = {
  exitCode: 1,
  output: [
    ...DOCTOR_HEAD,
    '  ✗ Profile                 /Users/me/.config/a8s/profile.json does not exist',
    '                            fix: a8s init',
    '  - Oasis                   not enabled',
    '  ! Okta                    Onebrief company sign-in required',
    '                            fix: a8s login',
    '  ! Model route             not signed in to Claude, so sessions open without a default model',
    '      fix: run /login in a session and choose Anthropic, or a8s init --force',
    ...DOCTOR_TAIL
  ].join('\n')
}

/** The sentence a8s stopped with when the profile's subscription had no sign-in. */
export const SUBSCRIPTION_SIGNED_OUT = 'Your selected subscription is signed out. Run a8s init --force; no other billing route was selected.'

/** The sentence a8s stopped with when there was no profile. */
export const PROFILE_NOT_FOUND = 'Profile not found: /Users/me/.config/a8s/profile.json. Run a8s init to create it, or pass --profile FILE.'

/**
 * The first `a8s start <folder> --mode acp --approval-mode always-ask` of the profile: the one-time metrics
 * notice, then the stop, all on stderr, 1.5 s after spawn and before any answer to `initialize`; exit 1.
 * Nothing was written to stdout.
 */
const FIRST_LAUNCH_STDERR = [
  'What Autonomous collects · please help us improve!',
  'Personal sessions export metrics as they run. The Alpha has no metrics opt-out:',
  '  - Exact timestamps, capture and related session IDs, harness version, OS,',
  '    repositories, model routes, tokens, cost, checks, how each call was billed',
  '    (subscription, API key or Bifrost), tool and personal skill names, counts.',
  '  - Commit IDs, previous revisions, Git actions. PR URLs, creation, age, state',
  '    and exact first-run CI results.',
  'Metrics include no prompts, replies, files, diffs, tool arguments or output.',
  'Terminal sessions enable Hivemind by default; your On/Off choice is saved.',
  '/hivemind reviews uploads; /hivemind off saves Off and cancels pending uploads.',
  'Launch excludes atomEngine, battleroad and battleroad-*; Hivemind needs Git.',
  'Hivemind uploads new prompts, replies, tool records and subagents to Dark',
  'Factory. Logs identify your Factory account; Factory operators can read them.',
  'They can link PR/CI outcomes for training and evaluation. Review the scope,',
  'redaction and retention disclosure. Uploads wait until close and a CUI check.',
  'Protocol runs start Off. Accepted evidence remains retained.',
  "Metrics retain the capture's original IDs and exact values. Credentials are",
  'redacted. There is no anonymization or artificial export delay.',
  'Only personal sessions started after this notice export metrics, including',
  'sessions with Hivemind enabled. Company sessions export no metrics.',
  'Read more in docs/explanation/usage-export.md in the autonomous repo.',
  'See exactly what was sent, session by session: a8s sessions sent',
  `Autonomous stopped: ${SUBSCRIPTION_SIGNED_OUT}`,
  ''
].join('\n')

/** The next launch, with `--model anthropic/claude-haiku-5-5`: a repository check, then the same stop 7 s after spawn; exit 1. */
const LATER_LAUNCH_STDERR = ['Checking for restricted repositories…', '  ✓ No restricted repositories · 1 folder · 1 repository · 1s', `Autonomous stopped: ${SUBSCRIPTION_SIGNED_OUT}`, ''].join('\n')

/** A launch with no profile: one line 0.8 s after spawn, before any answer to `initialize`; exit 2. */
const NO_PROFILE_STDERR = `${PROFILE_NOT_FOUND}\n`

/** What `acpProcess.ts` tells the connection of an exit: the exit code and the last 500 characters of stderr, trimmed. */
function stopped(code: number, stderr: string): string {
  return `exit code ${code}: ${stderr.slice(-500).trim()}`
}

/** The close detail of each recorded launch, as the adapter's connection receives it. */
export const SIGNED_OUT_EXITS = {
  firstLaunch: stopped(1, FIRST_LAUNCH_STDERR),
  laterLaunch: stopped(1, LATER_LAUNCH_STDERR),
  noProfile: stopped(2, NO_PROFILE_STDERR)
}
