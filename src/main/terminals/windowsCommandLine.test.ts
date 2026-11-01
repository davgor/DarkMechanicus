/**
 * The Windows command line a terminal's `.exe` is started with is built by the app, with the quoting Node's
 * `child_process` uses (libuv's `quote_cmd_arg`), so the program's own parser (`CommandLineToArgvW` rules) reads
 * back exactly the arguments the app meant. The round trip below parses the line with those rules.
 */
import { describe, expect, it } from 'vitest'
import { windowsCommandLine } from './windowsCommandLine'

/** A run of backslashes and the quote after it, a run of backslashes alone, a space or tab, or any other character. */
const TOKEN = /(\\*)"|(\\+)|([ \t])|([^\\" \t])/g

interface ParseState {
  args: string[]
  /** The argument being read; null between arguments. */
  current: string | null
  inQuotes: boolean
}

/** `n` backslashes before a quote stand for half as many; an odd one out makes the quote literal, else it opens or closes quotes. */
function readQuote(state: ParseState, backslashes: number): void {
  state.current = `${state.current ?? ''}${'\\'.repeat(Math.floor(backslashes / 2))}`
  if (backslashes % 2 === 1) {
    state.current += '"'
  } else {
    state.inQuotes = !state.inQuotes
  }
}

function readToken(state: ParseState, [, quoteSlashes, slashes, space, char]: RegExpMatchArray): void {
  if (space !== undefined && !state.inQuotes) {
    if (state.current !== null) {
      state.args.push(state.current)
    }
    state.current = null
    return
  }
  if (quoteSlashes === undefined) {
    state.current = `${state.current ?? ''}${slashes ?? space ?? char ?? ''}`
    return
  }
  readQuote(state, quoteSlashes.length)
}

/** Splits a command line the way the Microsoft C runtime does (the rules libuv's quoting is written for). */
function parseCommandLine(line: string): string[] {
  const state: ParseState = { args: [], current: null, inQuotes: false }
  for (const token of line.matchAll(TOKEN)) {
    readToken(state, token)
  }
  return state.current === null ? state.args : [...state.args, state.current]
}

describe('windowsCommandLine', () => {
  it('quotes exactly as Node does: plain words bare, spaces in quotes, quotes and the backslashes before them escaped', () => {
    expect(windowsCommandLine(['--model', 'haiku'])).toBe('--model haiku')
    expect(windowsCommandLine([''])).toBe('""')
    expect(windowsCommandLine(['C:\\Users\\me\\My Repo'])).toBe('"C:\\Users\\me\\My Repo"')
    expect(windowsCommandLine(['C:\\no\\spaces'])).toBe('C:\\no\\spaces')
    expect(windowsCommandLine(['say "hi"'])).toBe('"say \\"hi\\""')
    expect(windowsCommandLine(['a\\"b'])).toBe('"a\\\\\\"b"')
    expect(windowsCommandLine(['C:\\My Dir\\'])).toBe('"C:\\My Dir\\\\"')
    expect(windowsCommandLine(['tab\there'])).toBe('"tab\there"')
  })

  it('round-trips hostile arguments through the C runtime parser unchanged', () => {
    const args = [
      'C:\\Program Files\\Claude\\claude.exe',
      '',
      ' ',
      '"',
      '\\',
      '\\\\"\\',
      'end\\',
      'both "quoted" and \\"escaped\\"',
      'line one\nline two',
      '%PATH% & echo pwned | more ^ <x> (y)',
      '{"ok":true,"data":"a b"}'
    ]

    expect(parseCommandLine(windowsCommandLine(args))).toEqual(args)
  })

  it('refuses an argument with a NUL character, which no command line can carry', () => {
    expect(() => windowsCommandLine(['a\u0000b'])).toThrow(/NUL/)
  })
})
