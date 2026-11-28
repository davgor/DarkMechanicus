/**
 * Each cult member's colour, stable by the member's order within its run: the roster, the pipeline and the chamber all
 * take it from here. The Magos keeps the red robe and has no hue; acolytes take a fixed list of 24 hues, one every 15°,
 * ordered so the first few in a run are far apart and the hues nearest the Magos's red come last.
 */

/** Positions on the 15° wheel (8° + 15° × position), in the order acolytes take them. */
const WHEEL_ORDER = [12, 4, 20, 8, 16, 2, 14, 6, 18, 10, 22, 1, 13, 5, 21, 9, 17, 3, 15, 7, 19, 11, 0, 23] as const

/** One hue per acolyte of a full run (24 is the cap's ceiling), in degrees. */
export const MEMBER_HUES: readonly number[] = WHEEL_ORDER.map((position) => 8 + position * 15)

/** The hue of the run's `index`-th acolyte (0-based, in join order), in degrees; it wraps past 24. */
export function memberHue(index: number): number {
  const count = MEMBER_HUES.length
  return MEMBER_HUES[((Math.floor(index) % count) + count) % count]
}

/** The colour of the run's `index`-th acolyte, as the chamber's name plates and bubbles draw it. */
export function memberColor(index: number): string {
  return `hsl(${memberHue(index)} 70% 58%)`
}
