import { describe, expect, it } from 'vitest'
import { thrownBy } from '../test/thrownBy'
import { DomainError, fail, toErrorShape } from './errors'

describe('DomainError', () => {
  it('carries code, message and details', () => {
    const error = new DomainError('not_found', 'No such epic', { epicId: 'ep_1' })
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('No such epic')
    expect(error.details).toEqual({ epicId: 'ep_1' })
  })

  it('is a named Error subclass', () => {
    const error = new DomainError('conflict', 'stale')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(DomainError)
    expect(error.name).toBe('DomainError')
    expect(error.details).toBeUndefined()
  })

  it('shapes with details when present', () => {
    const shape = new DomainError('invalid_input', 'bad', { field: 'title' }).toShape()
    expect(shape).toStrictEqual({ code: 'invalid_input', message: 'bad', details: { field: 'title' } })
  })

  it('omits the details key entirely when there are none', () => {
    const shape = new DomainError('invalid_input', 'bad').toShape()
    expect(shape).toStrictEqual({ code: 'invalid_input', message: 'bad' })
    expect('details' in shape).toBe(false)
  })

  it('keeps empty details objects', () => {
    expect(new DomainError('internal', 'x', {}).toShape()).toStrictEqual({
      code: 'internal',
      message: 'x',
      details: {}
    })
  })
})

describe('fail', () => {
  it('throws a DomainError with the given fields', () => {
    const error = thrownBy(() => fail('stale_draft', 'Draft moved', { expected: 2, actual: 3 }))
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toMatchObject({
      code: 'stale_draft',
      message: 'Draft moved',
      details: { expected: 2, actual: 3 }
    })
  })

  it('throws without details when none are given', () => {
    const error = thrownBy(() => fail('run_not_active', 'No run'))
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).details).toBeUndefined()
  })
})

describe('toErrorShape', () => {
  it('passes a DomainError through with its details', () => {
    const error = new DomainError('unauthorized', 'nope', { role: 'worker' })
    expect(toErrorShape(error)).toStrictEqual({ code: 'unauthorized', message: 'nope', details: { role: 'worker' } })
  })

  it('passes a DomainError without details through without a details key', () => {
    expect(toErrorShape(new DomainError('gate_blocked', 'closed'))).toStrictEqual({
      code: 'gate_blocked',
      message: 'closed'
    })
  })

  it('maps a plain Error to internal with its message', () => {
    expect(toErrorShape(new Error('disk on fire'))).toStrictEqual({ code: 'internal', message: 'disk on fire' })
    expect(toErrorShape(new TypeError('bad type'))).toStrictEqual({ code: 'internal', message: 'bad type' })
  })

  it.each([
    ['boom', 'boom'],
    [42, '42'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ message: 'looks like an error' }, '[object Object]']
  ])('maps the non-error value %s to internal', (value, message) => {
    expect(toErrorShape(value)).toStrictEqual({ code: 'internal', message })
  })
})
