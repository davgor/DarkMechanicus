import { describe, expect, it } from 'vitest'
import { agentView } from '../__mocks__/fixtures'
import { agentName, agentVersionLabel, AGENT_BLURBS, connectedViaText, CUSTOM_AGENT_BLURB, phaseText, signInLabel } from './agentText'

describe('agentName', () => {
  it('uses a connected custom agent\'s display name, and a generic one once it is no longer connected', () => {
    const connected = [{ id: 'cu_01m65kwqqeyajbj5bnq81gngrb', displayName: 'My Claude' }]
    expect(agentName('cu_01m65kwqqeyajbj5bnq81gngrb', connected)).toBe('My Claude')
    expect(agentName('cu_01m65kwqqeyajbj5bnq81gngrb', [])).toBe('Custom agent')
    expect(agentName('cu_01m65kwqqeyajbj5bnq81gngrb')).toBe('Custom agent')
  })


  it('uses the display names the main process knows each agent by', () => {
    expect(agentName('claude')).toBe('Claude Code')
    expect(agentName('codex')).toBe('Codex')
    expect(agentName('cursor')).toBe('Cursor')
    expect(agentName('autonomous')).toBe('Autonomous')
    expect(agentName('omp')).toBe('Skitarii')
  })
})

describe('agentVersionLabel', () => {
  it('shows a built-in’s version as its probe read it', () => {
    expect(agentVersionLabel(agentView({ version: '2.1.4' }))).toBe('v2.1.4')
  })

  it('says Version unknown without a version, as for every custom CLI, which nothing runs to check', () => {
    expect(agentVersionLabel(agentView({ version: null }))).toBe('Version unknown')
    expect(agentVersionLabel(agentView({ kind: 'custom', version: null }))).toBe('Version unknown')
  })
})

describe('CUSTOM_AGENT_BLURB', () => {
  it('describes a custom CLI as a program and arguments, with no protocol', () => {
    expect(CUSTOM_AGENT_BLURB).not.toMatch(/protocol|ACP|Codex app-server|Claude Code SDK/i)
    expect(CUSTOM_AGENT_BLURB).toMatch(/terminal/)
  })
})

describe('AGENT_BLURBS', () => {
  it('gives each agent one line to tell it apart', () => {
    for (const kind of ['claude', 'codex', 'cursor', 'autonomous', 'omp'] as const) {
      expect(AGENT_BLURBS[kind]).not.toBe('')
      expect(AGENT_BLURBS[kind]).not.toContain('\n')
    }
  })
})

describe('signInLabel', () => {
  it('says so while the state is still being checked', () => {
    expect(signInLabel(undefined)).toEqual({ text: 'Checking sign-in…', tone: 'muted' })
  })

  it('names each state in words, with a tone besides', () => {
    expect(signInLabel({ state: 'signed_in', reason: 'ok' })).toEqual({ text: 'Signed in', tone: 'ok' })
    expect(signInLabel({ state: 'signed_out', reason: 'no' })).toEqual({ text: 'Signed out', tone: 'warn' })
    expect(signInLabel({ state: 'unchecked', reason: 'custom' })).toEqual({ text: 'Sign-in not checked', tone: 'muted' })
    expect(signInLabel({ state: 'unknown', reason: 'huh' })).toEqual({ text: 'Sign-in unknown', tone: 'muted' })
  })
})

describe('connectedViaText', () => {
  it('says how the agent was connected', () => {
    expect(connectedViaText('found')).toBe('Found on this computer')
    expect(connectedViaText('downloaded')).toBe('Downloaded by Dark Mechanicus')
    expect(connectedViaText('custom')).toBe('Added as a custom CLI')
  })
})

describe('phaseText', () => {
  it('asks for the confirmation first', () => {
    expect(phaseText({ phase: 'confirming', percent: null })).toBe('Waiting for your confirmation…')
  })

  it('shows the download percentage when it is known', () => {
    expect(phaseText({ phase: 'downloading', percent: 42 })).toBe('Downloading the installer… 42%')
    expect(phaseText({ phase: 'downloading', percent: null })).toBe('Downloading the installer…')
  })

  it('names every other step', () => {
    expect(phaseText({ phase: 'verifying', percent: null })).toBe('Verifying the download…')
    expect(phaseText({ phase: 'installing', percent: null })).toBe('Running the installer…')
    expect(phaseText({ phase: 'checking', percent: null })).toBe('Checking the installed program…')
    expect(phaseText({ phase: 'done', percent: null })).toBe('Finishing up…')
    expect(phaseText({ phase: 'cancelled', percent: null })).toBe('Cancelled.')
    expect(phaseText({ phase: 'failed', percent: null })).toBe('Stopped.')
  })
})

describe('the Skitarii card', () => {
  it('names Skitarii and the OMP it is built on, so a person can tell it from the other agents', () => {
    expect(AGENT_BLURBS.omp).toContain('Skitarii')
    expect(AGENT_BLURBS.omp).toContain('OMP')
    expect(new Set(Object.values(AGENT_BLURBS)).size).toBe(Object.keys(AGENT_BLURBS).length)
  })
})
