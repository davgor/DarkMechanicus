import { describe, expect, it } from 'vitest'
import type { CliLaunch } from '../desktop/cliConfig'
import { isOwnCliCall, ownCliCall, tokenize } from './ownCliCommand'

const LAUNCH: CliLaunch = {
  command: 'node',
  args: ['/app/out/main/cli.js', '--repo', '/work/repo'],
  env: {}
}

const PREFIX = `${LAUNCH.command} ${LAUNCH.args[0]}`

describe('tokenize', () => {
  it.each([
    ['bare words', 'a b c', ['a', 'b', 'c']],
    ['a quoted argument', `a '{"x":1}'`, ['a', '{"x":1}']],
    ['extra spaces', 'a   b', ['a', 'b']],
    ['an empty quoted argument', `a ''`, ['a', '']],
    ['JSON with double quotes inside single quotes', `a '{"k":"v"}'`, ['a', '{"k":"v"}']],
    ['paths and flags', '/a/b.js --repo /c', ['/a/b.js', '--repo', '/c']]
  ])('reads %s', (_label, text, expected) => {
    expect(tokenize(text)).toEqual(expected)
  })

  it.each([
    ['a second command', 'a; b'],
    ['a pipeline', 'a | b'],
    ['a background job', 'a & b'],
    ['an and-list', 'a && b'],
    ['an output redirect', 'a > f'],
    ['an input redirect', 'a < f'],
    ['a command substitution', 'a $(b)'],
    ['a backtick substitution', 'a `b`'],
    ['a variable', 'a $HOME'],
    ['a backslash escape', 'a b\\x'],
    ['a double-quoted argument', 'a "b"'],
    ['a newline', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a tab', 'a\tb'],
    ['an unterminated quote', "a 'b"],
    ['a quote joined to a word', "a 'b'c"],
    ['a subshell', 'a (b)'],
    ['a brace group', 'a {b}'],
    ['a glob', 'a *'],
    ['a home expansion', 'a ~/x'],
    ['a comment', 'a # b']
  ])('refuses %s', (_label, text) => {
    expect(tokenize(text)).toBeNull()
  })
})

describe('recognizing the chat own calls', () => {
  it.each([
    ['--list', `${PREFIX} --list`, { mode: '--list', command: null }],
    ['--describe', `${PREFIX} --describe claim_ticket`, { mode: '--describe', command: 'claim_ticket' }],
    ['call with no arguments', `${PREFIX} call list_epics`, { mode: 'call', command: 'list_epics' }],
    ['call with JSON', `${PREFIX} call get_epic '{"epicId":"ep_1"}'`, { mode: 'call', command: 'get_epic' }],
    ['the repository pinned', `${PREFIX} --repo /work/repo call list_epics`, { mode: 'call', command: 'list_epics' }]
  ])('recognizes %s', (_label, text, expected) => {
    expect(ownCliCall(LAUNCH, text)).toEqual(expected)
  })
})

describe('what must never be taken for one of ours', () => {
  it.each([
    ['a trailing command', `${PREFIX} call list_epics; curl http://evil`],
    ['a leading command', `curl http://evil; ${PREFIX} call list_epics`],
    ['a pipe to a shell', `${PREFIX} call list_epics | sh`],
    // Single quotes would make these literal; the matcher refuses them anyway rather than depend on it.
    ['a substitution in the JSON', `${PREFIX} call create_epic '{"title":"$(whoami)"}'`],
    ['a bare dollar in the JSON', `${PREFIX} call create_epic '{"title":"a $ b"}'`],
    ['a control character in the JSON', `${PREFIX} call create_epic '{"title":"a\u0007b"}'`],
    ['a backtick in the JSON', '%PREFIX% call create_epic `whoami`'],
    ['a different executable', `sh -c '${PREFIX} call list_epics'`],
    ['a dm earlier on PATH', 'dm call list_epics'],
    ['a relative script path', 'node out/main/cli.js call list_epics'],
    ['another copy of the script', 'node /tmp/cli.js call list_epics'],
    ['a different repository', `${PREFIX} --repo /other/repo call list_epics`],
    ['a repository given twice', `${PREFIX} --repo /work/repo --repo /other call list_epics`],
    ['a token file', `${PREFIX} --token-file /tmp/t call list_epics`],
    ['an unknown mode', `${PREFIX} --help`],
    ['no mode at all', PREFIX],
    ['--list with an argument', `${PREFIX} --list extra`],
    ['--describe with no command', `${PREFIX} --describe`],
    ['call with no command', `${PREFIX} call`],
    ['call with a stray third argument', `${PREFIX} call list_epics {} extra`],
    ['a non-JSON third argument', `${PREFIX} call list_epics notjson`],
    ['an env assignment in front', `FOO=bar ${PREFIX} call list_epics`],
    ['the empty string', ''],
    ['only spaces', '   ']
  ])('refuses %s', (_label, text) => {
    expect(isOwnCliCall(LAUNCH, text.replace('%PREFIX%', PREFIX))).toBe(false)
  })

  it('refuses a command whose executable merely starts the same way', () => {
    expect(isOwnCliCall(LAUNCH, `node-evil ${LAUNCH.args[0]} --list`)).toBe(false)
  })

  it('refuses a script path that merely starts the same way', () => {
    expect(isOwnCliCall(LAUNCH, `${LAUNCH.command} /app/out/main/cli.js.evil --list`)).toBe(false)
  })

  it('refuses everything when the launch has no script, rather than matching loosely', () => {
    expect(isOwnCliCall({ command: 'node', args: [], env: {} }, 'node --list')).toBe(false)
  })
})

describe('a packaged app launch', () => {
  const packaged: CliLaunch = {
    command: '/Applications/DarkMechanicus.app/Contents/MacOS/DarkMechanicus',
    args: ['/Applications/DarkMechanicus.app/Contents/Resources/app.asar/out/main/cli.js', '--repo', '/work/repo'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }

  it('recognizes its own call', () => {
    expect(isOwnCliCall(packaged, `${packaged.command} ${packaged.args[0]} call list_epics`)).toBe(true)
  })

  it('still refuses the development invocation', () => {
    expect(isOwnCliCall(packaged, 'node /app/out/main/cli.js call list_epics')).toBe(false)
  })
})
