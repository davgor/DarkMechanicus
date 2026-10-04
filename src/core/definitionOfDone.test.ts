/** How evidence is matched against a project's Definition of Done: by name, trimmed and case-insensitive. */
import { describe, expect, it } from 'vitest'
import type { CheckResult, DefinitionOfDoneCheck } from '../shared/domain/views'
import { checkNameKey, unmetChecks } from './definitionOfDone'

function check(name: string): DefinitionOfDoneCheck {
  return { name, command: `npm run ${name}`, description: '' }
}

function result(name: string, status: CheckResult['status']): CheckResult {
  return { name, status, detail: '' }
}

const DEFINITION = [check('lint'), check('typecheck'), check('test')]

describe('checkNameKey', () => {
  it('trims and lower-cases, and keeps inner spacing and punctuation', () => {
    expect(checkNameKey('  Unit Tests ')).toBe('unit tests')
    expect(checkNameKey('type-check')).toBe('type-check')
    expect(checkNameKey('unit  tests')).not.toBe(checkNameKey('unit tests'))
  })
})

describe('unmetChecks', () => {
  it('has nothing unmet when every named check passed', () => {
    const evidence = [result('lint', 'passed'), result('typecheck', 'passed'), result('test', 'passed')]
    expect(unmetChecks(DEFINITION, evidence)).toEqual([])
  })

  it('has nothing unmet for an empty definition, whatever the evidence says', () => {
    expect(unmetChecks([], [])).toEqual([])
    expect(unmetChecks([], [result('lint', 'failed')])).toEqual([])
  })

  it('matches names regardless of case and surrounding whitespace', () => {
    const evidence = [result(' LINT ', 'passed'), result('TypeCheck', 'passed'), result('Test\t', 'passed')]
    expect(unmetChecks(DEFINITION, evidence)).toEqual([])
  })

  it('does not match a name that only contains or resembles a check name', () => {
    const evidence = [result('lint all', 'passed'), result('typechecks', 'passed'), result('unit test', 'passed')]
    expect(unmetChecks(DEFINITION, evidence)).toEqual([
      { name: 'lint', reason: 'not reported' },
      { name: 'typecheck', reason: 'not reported' },
      { name: 'test', reason: 'not reported' }
    ])
  })

  it('names each missing check, in the order of the definition', () => {
    expect(unmetChecks(DEFINITION, [result('test', 'passed')])).toEqual([
      { name: 'lint', reason: 'not reported' },
      { name: 'typecheck', reason: 'not reported' }
    ])
  })
})

describe('unmetChecks: checks that were reported but did not pass', () => {
  it('says why a check that was reported did not pass', () => {
    const evidence = [result('lint', 'failed'), result('typecheck', 'skipped'), result('test', 'passed')]
    expect(unmetChecks(DEFINITION, evidence)).toEqual([
      { name: 'lint', reason: 'failed' },
      { name: 'typecheck', reason: 'skipped' }
    ])
  })

  it('requires every entry under a name to have passed, and a failure outranks a skip', () => {
    const evidence = [
      result('lint', 'passed'),
      result('lint', 'failed'),
      result('typecheck', 'passed'),
      result('typecheck', 'skipped'),
      result('test', 'skipped'),
      result('test', 'failed')
    ]
    expect(unmetChecks(DEFINITION, evidence)).toEqual([
      { name: 'lint', reason: 'failed' },
      { name: 'typecheck', reason: 'skipped' },
      { name: 'test', reason: 'failed' }
    ])
  })

  it('ignores evidence entries that name no check of the definition', () => {
    const evidence = [result('lint', 'passed'), result('typecheck', 'passed'), result('test', 'passed'), result('extra', 'failed')]
    expect(unmetChecks(DEFINITION, evidence)).toEqual([])
  })
})
