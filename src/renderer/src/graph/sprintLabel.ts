/**
 * Height of a sprint label (heading, goal, detail and, while editing, the + Ticket button).
 * jsdom and the layout model never measure text, so the label's height is estimated from its
 * text and then enforced: the node clamps the goal to the lines reserved here, so the rendered
 * label can never outgrow the space the layout gave it.
 */

/** Keep in sync with the 18px line height and 140px width of `.pg-sprint` in graph.css. */
const LINE_HEIGHT = 18
/** Characters that fit on one line; a little under the ~22 an average word-wrapped line holds. */
const CHARS_PER_LINE = 20
/** Longest goal shown in full; the rest is cut with an ellipsis (the full goal stays in the title). */
const MAX_GOAL_LINES = 6
/** `.pg-add`: a 6px gap above a 24px control. */
const ADD_BUTTON_HEIGHT = 30

export interface SprintLabelSize {
  /** Lines the goal is clamped to, at most `MAX_GOAL_LINES`. */
  goalLines: number
  /** Height of the whole label, in graph pixels. */
  height: number
}

/** Greedy word wrap at `CHARS_PER_LINE`; a word longer than a line breaks (overflow-wrap: anywhere). */
function wrappedLines(text: string): number {
  let lines = 1
  let used = 0
  for (const word of text.split(/\s+/).filter((item) => item !== '')) {
    if (used > 0 && used + 1 + word.length <= CHARS_PER_LINE) {
      used += 1 + word.length
      continue
    }
    lines += (used > 0 ? 1 : 0) + Math.floor((word.length - 1) / CHARS_PER_LINE)
    used = ((word.length - 1) % CHARS_PER_LINE) + 1
  }
  return lines
}

export function sprintLabelSize(goal: string, detail: string, withAddButton: boolean): SprintLabelSize {
  const goalLines = Math.min(wrappedLines(goal), MAX_GOAL_LINES)
  const lines = 1 + goalLines + wrappedLines(detail)
  return { goalLines, height: lines * LINE_HEIGHT + (withAddButton ? ADD_BUTTON_HEIGHT : 0) }
}
