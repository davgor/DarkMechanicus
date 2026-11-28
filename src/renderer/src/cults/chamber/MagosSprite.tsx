import { spritePlacement, spriteStyle } from '../../mascot/sprite'
import { MAGOS_SHEET } from './chamberArt'
import type { ChamberMagos } from './chamberState'
import type { ChamberLayout } from './layout'

/** The Magos's current action, its feet on the helm's standable top. Never tinted. */
export function MagosSprite({ magos, layout }: { magos: ChamberMagos; layout: ChamberLayout }): JSX.Element {
  const pose = spritePlacement({
    action: magos.action, elapsed: magos.elapsed, progress: 0, facing: MAGOS_SHEET.facing,
    x: layout.magos.x, y: layout.magos.y, scale: layout.magosCell / MAGOS_SHEET.cellSize
  }, MAGOS_SHEET)
  return <div className="cc-magos" data-action={magos.action} data-frame={pose.index} style={spriteStyle(pose)} />
}
