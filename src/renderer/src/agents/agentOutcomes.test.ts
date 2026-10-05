import { describe, expect, it } from 'vitest'
import type { AgentDownloadResult } from '../../../shared/desktop/api'
import { agentView } from '../__mocks__/fixtures'
import { downloadOutcome, findOutcome, signInOutcome } from './agentOutcomes'

describe('findOutcome', () => {
  it('confirms a connected agent with its version', () => {
    expect(findOutcome('Claude Code', { outcome: 'connected', agent: agentView({ version: '2.1.4' }) })).toEqual({
      tone: 'ok',
      title: 'Connected Claude Code 2.1.4',
      detail: null,
      output: []
    })
  })

  it('leaves out a version that could not be read', () => {
    const outcome = findOutcome('Codex', { outcome: 'connected', agent: agentView({ kind: 'codex', version: null }) })
    expect(outcome?.title).toBe('Connected Codex')
  })

  it('says nothing when the file dialog was closed', () => {
    expect(findOutcome('Codex', { outcome: 'cancelled' })).toBeNull()
  })

  it('shows why a pick was refused', () => {
    expect(findOutcome('Codex', { outcome: 'refused', code: 'wrong_program', reason: 'That is not Codex.' })).toEqual({
      tone: 'error',
      title: 'Not connected',
      detail: 'That is not Codex.',
      output: []
    })
  })
})

describe('downloadOutcome', () => {
  it('reports an install and an update differently', () => {
    const agent = agentView({ version: '3.0.0' })
    expect(downloadOutcome('Claude Code', { outcome: 'installed', agent, updated: false }).title).toBe(
      'Installed Claude Code 3.0.0'
    )
    expect(downloadOutcome('Claude Code', { outcome: 'installed', agent, updated: true }).title).toBe(
      'Updated Claude Code 3.0.0'
    )
  })

  it('says a declined confirmation changed nothing', () => {
    expect(downloadOutcome('Codex', { outcome: 'cancelled' })).toEqual({
      tone: 'warn',
      title: 'Download cancelled',
      detail: 'Nothing was downloaded or changed.',
      output: []
    })
  })

  it('shows the failure reason and the installer’s last lines', () => {
    const result: AgentDownloadResult = {
      outcome: 'failed',
      code: 'installer_failed',
      reason: 'The installer failed (exit code 1).',
      output: ['fetching', 'disk full']
    }
    expect(downloadOutcome('Codex', result)).toEqual({
      tone: 'error',
      title: 'Download failed',
      detail: 'The installer failed (exit code 1).',
      output: ['fetching', 'disk full']
    })
  })
})

describe('signInOutcome', () => {
  it('points at the terminal window the sign-in opened', () => {
    const outcome = signInOutcome({ outcome: 'started' })
    expect(outcome.tone).toBe('ok')
    expect(outcome.title).toBe('Sign-in started')
    expect(outcome.detail).toContain('terminal window')
  })

  it('shows why a sign-in could not start', () => {
    expect(signInOutcome({ outcome: 'not_connected', reason: 'Connect it first.' })).toEqual({
      tone: 'error',
      title: 'Could not start sign-in',
      detail: 'Connect it first.',
      output: []
    })
    expect(signInOutcome({ outcome: 'failed', reason: 'No terminal.' }).detail).toBe('No terminal.')
  })
})
