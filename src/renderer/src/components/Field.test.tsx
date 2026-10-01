// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Field } from './Field'

afterEach(cleanup)

describe('Field', () => {
  it('labels a single-line input', () => {
    const values: string[] = []
    render(<Field label="Title" value="abc" onChange={(value) => values.push(value)} />)
    const input = screen.getByLabelText('Title') as HTMLInputElement
    expect(input.tagName).toBe('INPUT')
    expect(input.value).toBe('abc')
    fireEvent.change(input, { target: { value: 'abcd' } })
    expect(values).toEqual(['abcd'])
  })

  it('becomes a textarea with the requested rows', () => {
    render(<Field label="Notes" value="" rows={4} onChange={() => undefined} />)
    const area = screen.getByLabelText('Notes') as HTMLTextAreaElement
    expect(area.tagName).toBe('TEXTAREA')
    expect(area.rows).toBe(4)
  })

  it('links a hint to the control without making it part of the label', () => {
    render(<Field label="Criteria" hint="One per line." value="" onChange={() => undefined} />)
    const input = screen.getByLabelText('Criteria')
    const hint = screen.getByText('One per line.')
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
  })

  it('has no description link without a hint', () => {
    render(<Field label="Title" value="" onChange={() => undefined} />)
    expect(screen.getByLabelText('Title').getAttribute('aria-describedby')).toBeNull()
  })

  it('limits the length when asked', () => {
    render(<Field label="Title" value="" maxLength={5} onChange={() => undefined} />)
    expect((screen.getByLabelText('Title') as HTMLInputElement).maxLength).toBe(5)
  })
})
