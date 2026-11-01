/**
 * The app's production CSP has `style-src 'self'`, which blocks every inline `<style>` element and reports each
 * one as a violation. xterm 6 adds `<style>` elements of its own (`docs/design/chat-shells.md`, "CSP"):
 * - its viewport adds one for the scrollbar slider's colors, empty at first, then filled from the theme: two
 *   violations at `open`, whatever the renderer; `terminalPane.css` gives the slider its colors instead;
 * - its DOM renderer adds two (cell dimensions and theme), and puts a `style` attribute on each styled run of text.
 *   It is created at `open` unless a renderer is already set, and again whenever the WebGL addon is disposed, so
 *   the WebGL addon is loaded before `open` and replaced inside this function after a lost context.
 * The blocked rules would never apply anyway. So that they are not added at all, xterm's `open` and the WebGL
 * addon's replacement run with `createElement('style')` answering a hidden `<div>`: xterm sets its text and
 * removes it as it would a style element, and nothing is applied or reported.
 */
export function withInertStyleElements<T>(doc: Document, work: () => T): T {
  const own = Object.getOwnPropertyDescriptor(doc, 'createElement')
  const create = doc.createElement.bind(doc)
  Object.defineProperty(doc, 'createElement', {
    configurable: true,
    writable: true,
    value: (tagName: string, options?: ElementCreationOptions): HTMLElement => {
      if (tagName.toLowerCase() !== 'style') {
        return create(tagName, options)
      }
      const inert = create('div')
      inert.hidden = true
      return inert
    }
  })
  try {
    return work()
  } finally {
    if (own === undefined) {
      Reflect.deleteProperty(doc, 'createElement')
    } else {
      Object.defineProperty(doc, 'createElement', own)
    }
  }
}
