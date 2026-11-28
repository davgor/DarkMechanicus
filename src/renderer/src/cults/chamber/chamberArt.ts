import backdropImage from '../../assets/chamber/backdrop.png'
import consoleImage from '../../assets/chamber/console.png'
import doorClosedImage from '../../assets/chamber/door-closed.png'
import doorOpenImage from '../../assets/chamber/door-open.png'
import helmImage from '../../assets/chamber/helm.png'
import props from '../../assets/chamber/props.json'
import teleportPadImage from '../../assets/chamber/teleport-pad.png'
import viewscreenImage from '../../assets/chamber/viewscreen.png'
import magosAtlas from '../../assets/magos/atlas.json'
import chronicleImage from '../../assets/magos/chronicle.png'
import magosIdleImage from '../../assets/magos/idle.png'
import orderAllImage from '../../assets/magos/order_all.png'
import orderOneImage from '../../assets/magos/order_one.png'
import petitionImage from '../../assets/magos/petition.png'
import speakImage from '../../assets/magos/speak.png'
import summonImage from '../../assets/magos/summon.png'
import { MASCOT_SHEET, type SpriteClip, type SpriteSheet } from '../../mascot/sprite'
import type { ChamberClipTimings, ClipTiming, MagosAction } from './chamberState'
import { SPRITE_CELL, type ChamberPropMetrics } from './layout'

/** The measured chamber art (`assets/chamber/props.json`): prop metrics plus the backdrop's size and floor line. */
export const CHAMBER_PROPS: ChamberPropMetrics & { backdrop: { width: number; height: number; floorY: number } } = props

export const SCENERY_IMAGES = {
  backdrop: backdropImage, console: consoleImage, doorOpen: doorOpenImage, doorClosed: doorClosedImage,
  helm: helmImage, teleportPad: teleportPadImage, viewscreen: viewscreenImage
}

/** The Magos's seven atlases; he faces left, into the room (petition faces the viewer). */
export const MAGOS_SHEET: SpriteSheet<MagosAction> = {
  atlas: magosAtlas,
  images: {
    idle: magosIdleImage, speak: speakImage, order_one: orderOneImage, order_all: orderAllImage,
    summon: summonImage, petition: petitionImage, chronicle: chronicleImage
  },
  cellSize: SPRITE_CELL,
  facing: 'left'
}

const timing = (clip: SpriteClip): ClipTiming => ({ fps: clip.fps, frames: clip.frames.length })

/** One-shot lengths from the real atlases, so the simulation hands over exactly when a clip ends. */
export const CHAMBER_CLIPS: ChamberClipTimings = {
  salute: timing(MASCOT_SHEET.atlas.actions.salute),
  speak: timing(magosAtlas.actions.speak),
  order_one: timing(magosAtlas.actions.order_one),
  order_all: timing(magosAtlas.actions.order_all),
  summon: timing(magosAtlas.actions.summon),
  chronicle: timing(magosAtlas.actions.chronicle)
}
