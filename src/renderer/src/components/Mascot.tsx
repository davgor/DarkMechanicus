import mascot1x from '../assets/brand-icon-128.png'
import mascot2x from '../assets/brand-icon-256.png'

interface MascotProps {
  /** Display size in CSS pixels; the bundled art is 128 px, with a 256 px file for dense screens. */
  size: number
}

/** The tech-priest, as decoration for the first-run screens. The text beside it carries the meaning. */
export function Mascot({ size }: MascotProps): JSX.Element {
  return (
    <img
      className="mascot"
      src={mascot1x}
      srcSet={`${mascot1x} 1x, ${mascot2x} 2x`}
      width={size}
      height={size}
      alt=""
    />
  )
}
