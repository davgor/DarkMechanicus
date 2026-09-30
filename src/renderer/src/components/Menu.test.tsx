// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Menu } from './Menu'

afterEach(cleanup)

function Harness(props: { picked: string[]; startOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(props.startOpen ?? false)
  return (
    <div>
      <button type="button">outside</button>
      <Menu
        label="Folder actions"
        open={open}
        onOpenChange={setOpen}
        items={[
          { id: 'stop', label: 'Stop tracking folder', onSelect: () => props.picked.push('stop') },
          { id: 'other', label: 'Other', onSelect: () => props.picked.push('other') }
        ]}
      />
    </div>
  )
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: 'Folder actions' })

describe('Menu trigger', () => {
  it('starts closed with a popup-aware trigger', () => {
    render(<Harness picked={[]} />)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens and closes from the trigger', () => {
    render(<Harness picked={[]} />)
    fireEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Stop tracking folder',
      'Other'
    ])
    fireEvent.click(trigger())
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('Menu selection', () => {
  it('runs the chosen item and closes', () => {
    const picked: string[] = []
    render(<Harness picked={picked} startOpen />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
    expect(picked).toEqual(['stop'])
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('Menu dismissal', () => {
  it('closes on Escape', () => {
    render(<Harness picked={[]} startOpen />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('ignores other keys', () => {
    render(<Harness picked={[]} startOpen />)
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.queryByRole('menu')).not.toBeNull()
  })

  it('closes when pressing outside but not inside', () => {
    render(<Harness picked={[]} startOpen />)
    fireEvent.mouseDown(screen.getByRole('menu'))
    expect(screen.queryByRole('menu')).not.toBeNull()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('stops listening once closed', () => {
    render(<Harness picked={[]} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(trigger())
    expect(screen.queryByRole('menu')).not.toBeNull()
  })
})
