import React from 'react'
import atlas from '../../src/renderer/src/assets/mascot/atlas.json'
import saluteImage from '../../src/renderer/src/assets/mascot/salute.png'
import typeImage from '../../src/renderer/src/assets/mascot/type.png'
import props from '../../src/renderer/src/assets/chamber/props.json'
import backdropImage from '../../src/renderer/src/assets/chamber/backdrop.png'
import consoleImage from '../../src/renderer/src/assets/chamber/console.png'
import doorOpenImage from '../../src/renderer/src/assets/chamber/door-open.png'
import doorClosedImage from '../../src/renderer/src/assets/chamber/door-closed.png'
import helmImage from '../../src/renderer/src/assets/chamber/helm.png'
import teleportPadImage from '../../src/renderer/src/assets/chamber/teleport-pad.png'
import viewscreenImage from '../../src/renderer/src/assets/chamber/viewscreen.png'
import { chamberLayout, type Rect } from '../../src/renderer/src/cults/chamber/layout'

export type AcolyteAction = 'salute' | 'type'
const IMAGES: Record<AcolyteAction, string> = { salute: saluteImage, type: typeImage }
/** The one-shot salute replays after this long, holding its last frame in between. */
const SALUTE_REPLAY_MS = 1600
const ROOM = { width: 1280, height: 800 }

interface LoopProps { action: AcolyteAction; time: number; x: number; y: number; size: number; facing?: 'left' | 'right' }

/** Preview-only atlas player for the acolyte poses that MascotSprite does not select yet. */
export function AcolyteLoop({ action, time, x, y, size, facing = 'right' }: LoopProps): JSX.Element {
  const clip = atlas.actions[action]
  const elapsed = clip.loop ? time : time % SALUTE_REPLAY_MS
  const step = Math.floor(elapsed * clip.fps / 1000)
  const index = clip.loop ? step % clip.frames.length : Math.min(clip.frames.length - 1, step)
  const frame = clip.frames[index]!
  const scale = size / atlas.cell.width
  const mirrored = facing === 'left'
  const anchorX = (mirrored ? frame.width - frame.footAnchor.x : frame.footAnchor.x) * scale
  return <div className="pg-mascot-sprite" aria-hidden="true" data-action={action} data-frame={index} style={{
    left: x - anchorX, top: y - frame.footAnchor.y * scale, width: frame.width * scale, height: frame.height * scale,
    backgroundImage: `url("${IMAGES[action]}")`,
    backgroundSize: `${atlas.cell.width * 3 * scale}px ${atlas.cell.height * 2 * scale}px`,
    backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
    transform: mirrored ? 'scaleX(-1)' : undefined
  }} />
}

function Prop({ src, rect, label }: { src: string; rect: Rect; label: string }): JSX.Element {
  return <img className="preview-prop" src={src} alt={label}
    style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
}

function Outline({ rect, kind }: { rect: Rect; kind: string }): JSX.Element {
  return <span className={`preview-metric preview-metric-${kind}`}
    style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
}

/** The backdrop and every prop at 1280×800, laid out by the chamber sim from the measured props.json. */
export function ChamberComposition({ time, outlines }: { time: number; outlines: boolean }): JSX.Element {
  const layout = chamberLayout(ROOM, props, 6)
  const size = 100 * layout.spriteScale
  // Scale the backdrop so its measured floor line lands on the room's floor line.
  const backdropScale = layout.floorY / props.backdrop.floorY
  return <div className="preview-chamber" style={{ ...ROOM, backgroundImage: `url("${backdropImage}")`,
    backgroundSize: `${props.backdrop.width * backdropScale}px ${props.backdrop.height * backdropScale}px` }}>
    <Prop src={viewscreenImage} rect={layout.viewscreen.rect} label="viewscreen" />
    <Prop src={time % 4000 < 2000 ? doorClosedImage : doorOpenImage} rect={layout.door.rect} label="blast door" />
    <Prop src={teleportPadImage} rect={layout.teleportPad.rect} label="teleport pad" />
    <Prop src={helmImage} rect={layout.helm.rect} label="helm" />
    {layout.consoles.map((item) => <Prop key={item.id} src={consoleImage} rect={item.rect} label={item.id} />)}
    {layout.consoles.map((item) => <AcolyteLoop key={item.id} action="type" time={time} size={size}
      x={item.rect.x + item.rect.width} y={layout.floorY} facing="left" />)}
    <AcolyteLoop action="salute" time={time} size={size * 1.45} x={layout.magos.x} y={layout.magos.y} />
    {outlines && <>
      <Outline rect={layout.viewscreen.window} kind="window" />
      <Outline rect={layout.door.doorway} kind="doorway" />
      {[layout.helm.top, ...layout.consoles.map((item) => item.top)].map((top) =>
        <Outline key={top.id} rect={{ ...top, height: 3 }} kind="stand" />)}
    </>}
  </div>
}
