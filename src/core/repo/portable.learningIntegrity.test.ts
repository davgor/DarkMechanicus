/** A learning integration record holds together: its manifest is its own card's and attempt's, and only a failed one records a failure. */
import { describe, expect, it } from 'vitest'
import { integrationManifest, LEARNING_SOURCE, startIntegration } from '../../test/learningFixtures'
import { createRepoEnv, initProject } from '../../test/repoEnv'
import { domainErrorOf, idOf } from '../../test/repoFixtures'
import { contentHash, prettyJson } from '../canonical'
import { buildLearningIntegrationRecord, learningIntegrationRecord, parseRecord } from './portable'

function exported(): Record<string, unknown> {
  const env = createRepoEnv()
  initProject(env)
  return buildLearningIntegrationRecord(env.db, startIntegration(env, 1)) as unknown as Record<string, unknown>
}

const refusal = (record: Record<string, unknown>): string => domainErrorOf(() => parseRecord(learningIntegrationRecord, prettyJson(record), 'integration.json')).message

describe('learningIntegrationRecord refuses an inconsistent record', () => {
  it('refuses a manifest naming another card or attempt', () => {
    const otherCard = integrationManifest({ cardId: idOf('kanbanCard', 77) })
    const otherAttempt = integrationManifest({ attemptId: idOf('kanbanAttempt', 78) })
    for (const manifest of [otherCard, otherAttempt]) {
      expect(refusal({ ...exported(), manifest, manifestHash: contentHash(manifest) })).toBe(
        'integration.json is not a valid record: manifest: The manifest names another card or attempt.'
      )
    }
  })

  it('refuses a failure on an integration that did not fail, and keeps one on a conflicted integration', () => {
    const failure = { code: 'conflict', message: 'The learning branch no longer applies.' }
    expect(refusal({ ...exported(), failure })).toBe('integration.json is not a valid record: failure: Only a conflicted or aborted integration records a failure.')
    const conflicted = parseRecord(learningIntegrationRecord, prettyJson({ ...exported(), state: 'conflicted', failure }), 'integration.json')
    expect([conflicted.state, conflicted.failure, conflicted.cardId]).toEqual(['conflicted', failure, LEARNING_SOURCE.cardId])
  })
})

describe('buildLearningIntegrationRecord', () => {
  it('refuses an integration that does not exist as not_found', () => {
    const env = createRepoEnv()
    const missing = idOf('learningIntegration', 99)
    const error = domainErrorOf(() => buildLearningIntegrationRecord(env.db, missing))
    expect([error.code, error.message]).toEqual(['not_found', `Learning integration ${missing} does not exist.`])
  })
})
