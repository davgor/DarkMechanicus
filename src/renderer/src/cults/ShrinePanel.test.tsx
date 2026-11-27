// @vitest-environment jsdom
/**
 * The Shrine panel (DM-632 c2, c3): an image or SVG renders as `img`; HTML only in an iframe whose `sandbox` is exactly
 * `allow-scripts`; both addressed as `dm-shrine:` by run and revision, never by path; a new revision reloads the view;
 * compact mode hides the details; Enlarge opens a dialog with the same sandbox; and the empty state shows before any
 * publish.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CultShrineView } from '../../../shared/cults/cultApi'
import { ShrinePanel } from './ShrinePanel'

const RUN = 'cr_01m8shrine000000000000000a'

function shrine(patch: Partial<CultShrineView> = {}): CultShrineView {
  return { path: '/home/u/code/alpha/gerry/index.html', revision: '1', kind: 'html', publishedBy: 'Acolyte Brass', updatedAt: '2026-11-27T12:30:00.000Z', ...patch }
}

const frames = (root: ParentNode = document) => [...root.querySelectorAll('iframe')]

afterEach(() => {
  cleanup()
})

describe('ShrinePanel content', () => {
  it('renders an image and an SVG as img from dm-shrine, never in a frame', () => {
    const view = render(<ShrinePanel runId={RUN} shrine={shrine({ path: '/w/gerry.png', kind: 'image', revision: '4' })} />)
    const image = screen.getByRole('img', { name: 'Shrine: gerry.png' })
    expect(image.tagName).toBe('IMG')
    expect(image.getAttribute('src')).toBe(`dm-shrine://shrine/${RUN}/4`)
    expect(frames()).toHaveLength(0)
    view.rerender(<ShrinePanel runId={RUN} shrine={shrine({ path: '/w/gerry.svg', kind: 'image', revision: '5' })} />)
    expect(screen.getByRole('img', { name: 'Shrine: gerry.svg' }).getAttribute('src')).toBe(`dm-shrine://shrine/${RUN}/5`)
    expect(frames()).toHaveLength(0)
  })

  it('renders HTML in an iframe whose sandbox is exactly allow-scripts, with no same-origin and no path', () => {
    render(<ShrinePanel runId={RUN} shrine={shrine()} />)
    const [frame] = frames()
    expect(frame).toBeDefined()
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame!.getAttribute('src')).toBe(`dm-shrine://shrine/${RUN}/1`)
    expect(frame!.getAttribute('src')).not.toContain('index.html')
    expect(frame!.getAttribute('title')).toBe('Shrine: index.html')
    expect(frame!.hasAttribute('allow')).toBe(false)
    expect(frame!.hasAttribute('srcdoc')).toBe(false)
  })

  it('reloads on a new revision: a new frame at the new address', () => {
    const view = render(<ShrinePanel runId={RUN} shrine={shrine()} />)
    const first = frames()[0]!
    view.rerender(<ShrinePanel runId={RUN} shrine={shrine({ revision: '2' })} />)
    const second = frames()[0]!
    expect(second).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(second.getAttribute('src')).toBe(`dm-shrine://shrine/${RUN}/2`)
    expect(second.getAttribute('sandbox')).toBe('allow-scripts')
    view.rerender(<ShrinePanel runId={RUN} shrine={shrine({ revision: '2', publishedBy: 'Magos Vettius' })} />)
    expect(frames()[0]).toBe(second)
  })

  it('shows the empty state before any publish, short in the viewscreen', () => {
    const view = render(<ShrinePanel runId={RUN} shrine={null} />)
    expect(screen.getByRole('status').textContent).toContain('No offering yet: no member has published to it.')
    view.rerender(<ShrinePanel runId={RUN} shrine={null} compact />)
    expect(screen.getByRole('status').textContent).toBe('No offering yet')
    expect(frames()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Enlarge' })).toBeNull()
  })
})

describe('ShrinePanel modes', () => {
  it('shows the published by member and the updated time in full mode, and hides every detail when compact', () => {
    const view = render(<ShrinePanel runId={RUN} shrine={shrine()} />)
    const panel = screen.getByRole('region', { name: 'Shrine' })
    expect(within(panel).getByText('Acolyte Brass')).toBeTruthy()
    expect(panel.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-27T12:30:00.000Z')
    view.rerender(<ShrinePanel runId={RUN} shrine={shrine()} compact />)
    expect(within(panel).queryByText('Acolyte Brass')).toBeNull()
    expect(panel.querySelector('time')).toBeNull()
    expect(panel.querySelector('dl')).toBeNull()
    expect(frames(panel)).toHaveLength(1)
    expect(within(panel).getByRole('button', { name: 'Enlarge' })).toBeTruthy()
  })

  it('Enlarge opens a dialog with the same sandboxed view and the details, tells the callback, and closes on Escape', () => {
    const onEnlarge = vi.fn()
    render(<ShrinePanel runId={RUN} shrine={shrine({ revision: '3' })} compact onEnlarge={onEnlarge} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge' }))
    expect(onEnlarge).toHaveBeenCalledOnce()
    const dialog = screen.getByRole('dialog', { name: 'Shrine' })
    const [large] = frames(dialog)
    expect(large!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(large!.getAttribute('src')).toBe(`dm-shrine://shrine/${RUN}/3`)
    expect(within(dialog).getByText('Acolyte Brass')).toBeTruthy()
    expect(within(dialog).getByText('index.html')).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enlarge of an image shows it as img in the dialog', () => {
    render(<ShrinePanel runId={RUN} shrine={shrine({ path: '/w/gerry.jpg', kind: 'image' })} compact />)
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge' }))
    const dialog = screen.getByRole('dialog', { name: 'Shrine' })
    expect(within(dialog).getByRole('img', { name: 'Shrine: gerry.jpg' }).tagName).toBe('IMG')
    expect(frames(dialog)).toHaveLength(0)
  })
})
