import atlas from '../assets/mascot/atlas.json'
import idleImage from '../assets/mascot/idle.png'

/** The idle sheet's first ("settled") frame, the plan graph mascot at rest. */
const FRAME = atlas.actions.idle.frames[0]!
/** A square around the character's opaque pixels in that frame (measured: x 92–412, y 76–457 of its 512 px cell). */
const CROP = { x: 60, y: 74, size: 384 }

/**
 * The plan graph's mascot as a still icon: one frame of the same idle sprite sheet, cropped to the character and drawn
 * at `size` CSS pixels. It never animates; the label beside it carries the meaning, so it is hidden from assistive tech.
 */
export function MascotGlyph({ size }: { size: number }): JSX.Element {
  const scale = size / CROP.size
  return (
    <span
      className="mascot-glyph"
      aria-hidden="true"
      data-frame={FRAME.name}
      style={{
        width: size,
        height: size,
        backgroundImage: `url("${idleImage}")`,
        backgroundSize: `${atlas.cell.width * 3 * scale}px ${atlas.cell.height * 2 * scale}px`,
        backgroundPosition: `${-(FRAME.x + CROP.x) * scale}px ${-(FRAME.y + CROP.y) * scale}px`
      }}
    />
  )
}
