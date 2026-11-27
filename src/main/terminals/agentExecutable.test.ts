import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAgentExecutable } from './agentExecutable'

describe('resolveAgentExecutable', () => {
  const never = (): string => {
    throw new Error('should not read')
  }

  it('runs a path as it is anywhere but behind a Windows shim', () => {
    expect(resolveAgentExecutable('/home/me/.local/bin/claude', 'linux', never)).toBe('/home/me/.local/bin/claude')
    expect(resolveAgentExecutable('/Users/me/.local/bin/claude', 'darwin', never)).toBe('/Users/me/.local/bin/claude')
    expect(resolveAgentExecutable('C:\\Users\\me\\.local\\bin\\claude.exe', 'win32', never)).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(resolveAgentExecutable('/opt/claude.cmd', 'linux', never)).toBe('/opt/claude.cmd')
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

    expect(resolveAgentExecutable(path, 'win32', () => NPM_SHIM)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    )
  })

  it('follows a shim that points at a native program', () => {
    const shim = 'endLocal & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'

    expect(resolveAgentExecutable('C:\\npm\\CLAUDE.CMD', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    expect(resolveAgentExecutable('C:\\npm\\claude.bat', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
  })

  it('reads the shim from disk by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-shim-'))
    try {
      writeFileSync(join(dir, 'claude.cmd'), NPM_SHIM)

      expect(resolveAgentExecutable(join(dir, 'claude.cmd'), 'win32')).toMatch(/node_modules\\@anthropic-ai\\claude-code\\cli\.js$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('follows an OMP npm shim to its script the same way', () => {
    const shim = NPM_SHIM.replace('@anthropic-ai\\claude-code\\cli.js', '@oh-my-pi\\pi-coding-agent\\dist\\cli.js')

    expect(resolveAgentExecutable('C:\\npm\\omp.cmd', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js')
  })

  it('follows the harness fake-omp shim to the fake-omp.js beside it', () => {
    const shim = '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-omp.js" %*\r\n'

    expect(resolveAgentExecutable('C:\\shim\\fake-omp.cmd', 'win32', () => shim)).toBe('C:\\shim\\fake-omp.js')
  })

  it.each(['claude.cmd', 'omp.cmd', 'omp.bat'])('uses a hand-written %s that is not the npm template, or cannot be read, as given', (name) => {
    const path = `C:\\bin\\${name}`

    expect(resolveAgentExecutable(path, 'win32', () => '@echo off\r\n"C:\\tools\\omp.exe" %*\r\n')).toBe(path)
    expect(resolveAgentExecutable(path, 'win32', () => '@echo hello')).toBe(path)
    expect(
      resolveAgentExecutable(path, 'win32', () => {
        throw new Error('EACCES')
      })
    ).toBe(path)
  })
})
