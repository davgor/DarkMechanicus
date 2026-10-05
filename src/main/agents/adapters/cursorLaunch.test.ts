import { describe, expect, it } from 'vitest'
import { cursorLaunch } from './cursorLaunch'

const POSIX = { platform: 'linux', inspect: () => 'ok' as const }
const WINDOWS = { platform: 'win32', inspect: () => 'ok' as const }

const HOSTILE_MODELS = [
  'x" & calc & "',
  'a&b',
  'a|b',
  'a^b',
  '%PATH%',
  'a b',
  'a"b',
  'a;b',
  'a(b)',
  'a>b',
  '!x!',
  '$(x)',
  '--yolo',
  '-rf',
  '',
  'a\nb',
  'a`b`'
]

const REAL_MODELS = [
  'auto',
  'gpt-5.3-codex',
  'composer-2.5',
  'o3',
  'claude-opus-4-7[thinking=true,effort=high]',
  'gpt-5.4[reasoning=medium,context=272k,fast=false]'
]

describe('cursorLaunch', () => {
  it('runs the executable with its subcommand as plain arguments', () => {
    expect(cursorLaunch('/opt/cursor/agent', { command: 'acp', model: null }, POSIX)).toEqual({
      file: '/opt/cursor/agent',
      args: ['acp'],
      verbatimArguments: false
    })
  })

  it('puts the model before the subcommand, as a separate argument', () => {
    expect(cursorLaunch('/opt/cursor/agent', { command: 'acp', model: 'gpt-5.3-codex' }, POSIX).args).toEqual([
      '--model',
      'gpt-5.3-codex',
      'acp'
    ])
  })

  it('runs a Windows shim through exactly one cmd.exe parse and quotes the model inside it', () => {
    const model = 'claude-opus-4-7[thinking=true,effort=high]'

    const launch = cursorLaunch('C:\\Tools\\agent.cmd', { command: 'acp', model }, WINDOWS)

    expect(launch).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `""C:\\Tools\\agent.cmd" --model "${model}" acp"`],
      verbatimArguments: true
    })
  })

  it('runs a Windows shim without a model like the other probes do', () => {
    const comspec = 'C:\\Windows\\System32\\cmd.exe'

    const launch = cursorLaunch('C:\\Tools\\agent.cmd', { command: 'models', model: null }, { ...WINDOWS, comspec })

    expect(launch).toEqual({
      file: comspec,
      args: ['/d', '/v:off', '/s', '/c', '""C:\\Tools\\agent.cmd" models"'],
      verbatimArguments: true
    })
  })

  it('hands a Windows program the model as its own, unquoted argument', () => {
    const launch = cursorLaunch('C:\\Tools\\agent.exe', { command: 'acp', model: 'gpt-5.4[a=b,c=d]' }, WINDOWS)

    expect(launch).toEqual({ file: 'C:\\Tools\\agent.exe', args: ['--model', 'gpt-5.4[a=b,c=d]', 'acp'], verbatimArguments: false })
  })
})

describe('cursorLaunch: the model id', () => {
  it.each(REAL_MODELS)('accepts the model id %s', (model) => {
    expect(() => cursorLaunch('/opt/agent', { command: 'acp', model }, POSIX)).not.toThrow()
  })

  it.each(HOSTILE_MODELS)('refuses the model id %j before anything is started', (model) => {
    expect(() => cursorLaunch('C:\\Tools\\agent.cmd', { command: 'acp', model }, WINDOWS)).toThrow(/model/i)
    expect(() => cursorLaunch('/opt/agent', { command: 'acp', model }, POSIX)).toThrow(/model/i)
  })

  it('refuses an executable the launch rules refuse, with their reason', () => {
    const none = { command: 'acp', model: null } as const

    expect(() => cursorLaunch('relative/agent', none, POSIX)).toThrow('That is not a file.')
    expect(() => cursorLaunch('C:\\Tools\\agent.cmd', none, { ...WINDOWS, inspect: () => 'not_a_file' })).toThrow('That is not a file.')
    expect(() => cursorLaunch('C:\\Tools\\100%\\agent.cmd', none, WINDOWS)).toThrow(/cannot be launched safely/)
  })
})
