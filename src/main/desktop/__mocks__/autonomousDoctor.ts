/**
 * What the installed Autonomous 0.79.0 (OMP 18.11.2) `a8s doctor` says with no model sign-in, captured on 2026-10-30
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
