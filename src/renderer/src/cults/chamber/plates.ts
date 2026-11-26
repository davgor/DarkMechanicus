/** Name-plate placement: plates stagger into rows under the feet so crowded rooms stay legible. */

export interface PlateInput {
  id: string
  /** The acolyte's feet x in room pixels; the plate is centred on it. */
  x: number
  name: string
  /** Speaking or outlined plates claim rows before the rest. */
  priority: boolean
  /** The selected member's plate is always shown, even with no free row. */
  forced: boolean
}

export interface PlatePlacement { row: number; hidden: boolean; width: number }

export const PLATE_ROWS = 3
const PLATE_GAP = 4
const PLATE_MAX_WIDTH = 120

/** The plate font size and the height of one plate row, as chamber.css draws them. */
export function plateMetrics(spriteScale: number): { font: number; rowHeight: number } {
  const font = 11 * Math.max(0.8, spriteScale)
  return { font, rowHeight: Math.ceil(font * 1.45) + 3 }
}

/** The plate's width bound: the mono name plus padding, capped; chamber.css ellipsizes past it. */
export function plateWidth(name: string, spriteScale: number): number {
  const { font } = plateMetrics(spriteScale)
  return Math.min(PLATE_MAX_WIDTH, Math.ceil([...name].length * font * 0.62) + 12)
}

type Span = [number, number]

const clear = (spans: Span[], [left, right]: Span): boolean =>
  spans.every(([from, to]) => right + PLATE_GAP <= from || to + PLATE_GAP <= left)

/**
 * Plates take the first row, left to right, where they overlap no other plate: the forced plate first, then
 * priority plates, then the rest. A plate that fits no row is hidden, unless forced.
 */
export function layoutPlates(plates: readonly PlateInput[], spriteScale: number): Map<string, PlatePlacement> {
  const rows: Span[][] = Array.from({ length: PLATE_ROWS }, () => [])
  const placed = new Map<string, PlatePlacement>()
  const rank = (plate: PlateInput): number => plate.forced ? 0 : plate.priority ? 1 : 2
  const order = [...plates].sort((a, b) => rank(a) - rank(b) || a.x - b.x || a.id.localeCompare(b.id))
  for (const plate of order) {
    const width = plateWidth(plate.name, spriteScale)
    const span: Span = [plate.x - width / 2, plate.x + width / 2]
    const row = rows.findIndex((spans) => clear(spans, span))
    if (row >= 0) rows[row]!.push(span)
    placed.set(plate.id, { row: Math.max(0, row), hidden: row < 0 && !plate.forced, width })
  }
  return placed
}
