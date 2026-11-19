import { describe, expect, it } from 'vitest'
import { correctionRoute, routeText } from './correctionRoute'

describe('DM-191 c1: an experiment is routed to the destination it names', () => {
  it('routes Dark Mechanicus work to a new epic in the chosen checkout, from an experiment or a proposal kind', () => {
    expect(correctionRoute({ kind: 'darkmechanicus_source' })).toEqual({ kind: 'darkmechanicus_source' })
    expect(correctionRoute('darkmechanicus_source')).toEqual({ kind: 'darkmechanicus_source' })
    expect(routeText({ kind: 'darkmechanicus_source' })).toBe('Dark Mechanicus source (a new epic in your Dark Mechanicus checkout)')
  })

  it('keeps same-repository work in this project, naming the repository of a folder of repositories', () => {
    expect(correctionRoute({ kind: 'source_repository', repository: 'api' })).toEqual({ kind: 'same_repository', repository: 'api' })
    expect(correctionRoute({ kind: 'source_repository', repository: null })).toEqual({ kind: 'same_repository', repository: null })
    expect(correctionRoute('source_repository')).toEqual({ kind: 'same_repository', repository: null })
    expect(routeText({ kind: 'same_repository', repository: 'api' })).toBe('Source repository api')
    expect(routeText({ kind: 'same_repository', repository: null })).toBe('Source repository')
  })
})
