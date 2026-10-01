/**
 * Minimal browser APIs React Flow needs under jsdom. The ResizeObserver never reports, so nodes
 * keep the fixed sizes and handle positions the graph model gives them.
 */
class SilentResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function installDomShims(): void {
  globalThis.ResizeObserver = SilentResizeObserver
  // React Flow's click-to-connect looks for the handle under the pointer; jsdom has no layout.
  document.elementFromPoint = () => null
}
