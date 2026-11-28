import type { CSSProperties } from 'react'

export interface BubbleInput {
  id: string
  /** Already capped (with its ellipsis) by the chamber state; drawn as it is. */
  text: string
  /** The speaker's head: the bubble's tail points here. */
  x: number
  headY: number
  color: string
  /** The Magos and the selected member place first, so a crowded room drops others' bubbles before theirs. */
  priority: boolean
}

interface BubblePlacement extends BubbleInput {
  left: number
  top: number
  width: number
  height: number
  /** True when the bubble extends left of the speaker, near the room's right edge. */
  flipped: boolean
  tailX: number
}

const BUBBLE_WIDTH = 200
const FONT = 12
const CHAR_WIDTH = FONT * 0.62
const LINE = 16
const PAD = 8
const TAIL = 16
const TAIL_HEIGHT = 8
const MARGIN = 6
const GAP = 4

/** The bubble's size for its text: mono characters per line, one spare line for word wrapping. */
function bubbleSize(text: string): { width: number; height: number } {
  const characters = [...text].length
  const perLine = Math.floor((BUBBLE_WIDTH - 2 * PAD - 2) / CHAR_WIDTH)
  const lines = characters <= perLine ? 1 : Math.ceil(characters / perLine) + 1
  const width = lines === 1 ? Math.ceil(characters * CHAR_WIDTH) + 2 * PAD + 2 : BUBBLE_WIDTH
  return { width, height: lines * LINE + 2 * PAD }
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high))

const overlaps = (a: BubblePlacement, b: BubblePlacement): boolean =>
  a.left < b.left + b.width + GAP && b.left < a.left + a.width + GAP &&
  a.top < b.top + b.height + GAP && b.top < a.top + a.height + GAP

/** Extends right of the head, or left of it near the right edge; always inside the room's width. */
function placeOne(bubble: BubbleInput, roomWidth: number): BubblePlacement {
  const { width, height } = bubbleSize(bubble.text)
  const flipped = bubble.x - TAIL + width > roomWidth - MARGIN
  const left = clamp(flipped ? bubble.x + TAIL - width : bubble.x - TAIL, MARGIN, roomWidth - width - MARGIN)
  return { ...bubble, left, top: bubble.headY - TAIL_HEIGHT - height, width, height, flipped,
    tailX: clamp(bubble.x - left, 10, width - 10) }
}

/** A bubble rises at most this many bubble heights above its speaker; higher, its tail would point at no one. */
const MAX_LIFT = 2

/** Raises `bubble` above every placed bubble it would overlap; null when that leaves the room or its speaker. */
function stackUp(bubble: BubblePlacement, placed: readonly BubblePlacement[]): BubblePlacement | null {
  const highest = Math.max(MARGIN, bubble.top - MAX_LIFT * (bubble.height + GAP))
  let next = bubble
  for (let guard = 0; guard <= placed.length; guard += 1) {
    const blocker = placed.find((other) => overlaps(next, other))
    if (!blocker) return next.top >= highest ? next : null
    next = { ...next, top: blocker.top - next.height - GAP }
  }
  return null
}

/**
 * Bubbles placed inside the room without overlapping: priority bubbles first, then lower heads first, each raised
 * above those it would cover. A bubble with no room left above is not drawn, so nothing stacks illegibly.
 */
export function layoutBubbles(bubbles: readonly BubbleInput[], roomWidth: number): BubblePlacement[] {
  const placed: BubblePlacement[] = []
  const order = [...bubbles].sort((a, b) => Number(b.priority) - Number(a.priority) || b.headY - a.headY ||
    a.x - b.x || a.id.localeCompare(b.id))
  for (const bubble of order) {
    const fitted = stackUp(placeOne(bubble, roomWidth), placed)
    if (fitted) placed.push(fitted)
  }
  return placed
}

/** A rounded speech bubble with a tail, bordered in the speaker's colour. Plain text only. */
export function SpeechBubble({ bubble }: { bubble: BubblePlacement }): JSX.Element {
  const style = { left: bubble.left, top: bubble.top, width: bubble.width, minHeight: bubble.height,
    '--bubble-color': bubble.color, '--tail-x': `${bubble.tailX}px` } as CSSProperties
  return <div className="cc-bubble" data-speaker={bubble.id} data-flipped={bubble.flipped} style={style}>
    {bubble.text}
  </div>
}
