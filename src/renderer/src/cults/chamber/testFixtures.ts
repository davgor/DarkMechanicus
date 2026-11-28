import type { ChamberPropMetrics } from './layout'

/** Prop metrics shaped like the art ticket's props.json, in image pixels. */
export const PROPS: ChamberPropMetrics = {
  helm: { width: 300, height: 360, standTop: { left: 40, right: 260, y: 60 } },
  console: { width: 200, height: 220, standTop: { left: 12, right: 188, y: 36 } },
  teleportPad: { width: 240, height: 60, footY: 50 },
  door: { width: 220, height: 520, doorway: { x: 40, y: 60, width: 140, height: 460 } },
  viewscreen: { width: 600, height: 360, window: { x: 40, y: 40, width: 520, height: 280 } }
}

export const ROOMS = [
  { width: 800, height: 450 },
  { width: 1280, height: 600 },
  { width: 1920, height: 800 }
] as const
