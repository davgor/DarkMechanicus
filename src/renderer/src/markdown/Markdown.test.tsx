// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import { Markdown } from './Markdown'

let opened: string[] = []

beforeEach(() => {
  opened = []
  const bridge: Pick<DmApi, 'openExternal'> = {
    openExternal: (url: string) => {
      opened.push(url)
      return Promise.resolve(true)
    }
  }
  window.dm = bridge as DmApi
})

afterEach(() => {
  cleanup()
})

const HOSTILE = [
  '<script>alert(1)</script>',
  '',
  '<img src=x onerror=alert(1)>',
  '',
  '[click](javascript:alert(1)) [data](data:text/html,x) [file](file:///etc/passwd)',
  '',
  '[vb](vbscript:msgbox(1)) and [ok](https://example.com/docs)',
  '',
  '<iframe src="https://evil.example"></iframe>'
].join('\n')

describe('Markdown hostile input', () => {
  it('renders raw HTML as text and never creates executable elements', () => {
    const { container } = render(<Markdown source={HOSTILE} />)
    expect(container.querySelectorAll('script, img, iframe').length).toBe(0)
    expect(container.textContent?.includes('<script>alert(1)</script>')).toBe(true)
    expect(container.textContent?.includes('<img src=x onerror=alert(1)>')).toBe(true)
  })

  it('keeps only allow-listed links clickable', () => {
    const { container } = render(<Markdown source={HOSTILE} />)
    const links = [...container.querySelectorAll('a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.com/docs'])
    expect(container.textContent?.includes('click')).toBe(true)
    expect(container.textContent?.includes('javascript:')).toBe(false)
  })

  it('opens links through the bridge and prevents in-app navigation', () => {
    const { getByText } = render(<Markdown source="See [the docs](https://example.com/docs)." />)
    const notPrevented = fireEvent.click(getByText('the docs'))
    expect(notPrevented).toBe(false)
    expect(opened).toEqual(['https://example.com/docs'])
  })
})

describe('Markdown structure', () => {
  it('renders headings offset below the panel title, lists and task boxes', () => {
    const source = '# Top\n## Sub\n\n- [x] done\n- [ ] open\n\n3. third\n\n> quote\n\n---'
    const { container } = render(<Markdown source={source} className="extra" />)
    expect(container.firstElementChild?.className).toBe('md extra')
    expect(container.querySelector('h3')?.textContent).toBe('Top')
    expect(container.querySelector('h4')?.textContent).toBe('Sub')
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true]
    ])
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3')
    expect(container.querySelector('blockquote')?.textContent).toBe('quote')
    expect(container.querySelectorAll('hr').length).toBe(1)
  })

  it('renders code, emphasis and hard breaks', () => {
    const source = '```\n<b>x</b>\n```\n\n**bold** *it* `code`  \nnext\n\n- item\n\n  more'
    const { container } = render(<Markdown source={source} />)
    expect(container.className).toBe('')
    expect(container.firstElementChild?.className).toBe('md')
    expect(container.querySelector('pre code')?.textContent).toBe('<b>x</b>')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('it')
    expect(container.querySelector('.md-inline-code')?.textContent).toBe('code')
    expect(container.querySelectorAll('br').length).toBe(1)
    const item = container.querySelector('li')
    expect(item?.firstChild?.textContent).toBe('item')
    expect(item?.querySelector('p')?.textContent).toBe('more')
  })

  it('keeps a list item that starts with a non-paragraph block', () => {
    const { container } = render(<Markdown source={'- # heading item'} />)
    expect(container.querySelector('li h3')?.textContent).toBe('heading item')
  })
})
