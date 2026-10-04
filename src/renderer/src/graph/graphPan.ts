/** Only drag movement is a shake input. React Flow also reports fit, zoom and wheel moves here. */
export function isUserPanEvent(event: { type: string } | null): boolean {
  return event !== null && (event.type === 'mousemove' || event.type === 'pointermove' || event.type === 'touchmove')
}
