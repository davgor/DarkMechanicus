import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveClaudeExecutable } from './claudeExecutable'

describe('resolveClaudeExecutable', () => {
  const never = (): string => {
    throw new Error('should not read')
  }

  it('runs a path as it is anywhere but behind a Windows shim', () => {
    expect(resolveClaudeExecutable('/home/me/.local/bin/claude', 'linux', never)).toBe('/home/me/.local/bin/claude')
    expect(resolveClaudeExecutable('/Users/me/.local/bin/claude', 'darwin', never)).toBe('/Users/me/.local/bin/claude')
    expect(resolveClaudeExecutable('C:\\Users\\me\\.local\\bin\\claude.exe', 'win32', never)).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(resolveClaudeExecutable('/opt/claude.cmd', 'linux', never)).toBe('/opt/claude.cmd')
  })

  const NPM_SHIM = [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
  ].join('\r\n')

  it('follows an npm shim to the script it runs, not to the node it checks for first', () => {
    const path = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'

    expect(resolveClaudeExecutable(path, 'win32', () => NPM_SHIM)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    )
  })

  it('follows a shim that points at a native program', () => {
    const shim = 'endLocal & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'

    expect(resolveClaudeExecutable('C:\\npm\\CLAUDE.CMD', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    expect(resolveClaudeExecutable('C:\\npm\\claude.bat', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
  })

  it('reads the shim from disk by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-shim-'))
    try {
      writeFileSync(join(dir, 'claude.cmd'), NPM_SHIM)

      expect(resolveClaudeExecutable(join(dir, 'claude.cmd'), 'win32')).toMatch(/node_modules\\@anthropic-ai\\claude-code\\cli\.js$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says what to do when the shim cannot be followed or read', () => {
    expect(() => resolveClaudeExecutable('C:\\npm\\claude.cmd', 'win32', () => '@echo hello')).toThrow(/Connect claude\.exe/)
    expect(() =>
      resolveClaudeExecutable('C:\\npm\\claude.cmd', 'win32', () => {
        throw new Error('EACCES')
      })
    ).toThrow(/Connect claude\.exe/)
  })
})
