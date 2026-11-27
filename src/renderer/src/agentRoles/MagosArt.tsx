import { type ArtProps, ArtDefs, useArtIds } from './artParts'

const HALO_TEETH = Array.from({ length: 12 }, (_, index) => index * 30)
const CHEST_TEETH = Array.from({ length: 8 }, (_, index) => index * 45)
/** The three mechadendrites, each a segmented brass cable over a steel core. */
const DENDRITES = [
  'M46 104 C22 102 10 82 16 64 C19 54 24 48 24 40',
  'M116 96 C136 92 150 76 144 54',
  'M120 112 C142 112 152 128 144 144'
]

function CogHalo(): JSX.Element {
  return (
    <g>
      <circle className="ra-crimson-soft" cx="80" cy="56" r="56" />
      <g className="ra-brass">
        {HALO_TEETH.map((angle) => <rect key={angle} x="75" y="7" width="10" height="11" rx="1.5" transform={`rotate(${angle} 80 56)`} />)}
      </g>
      <circle className="ra-stroke-brass" cx="80" cy="56" r="41" strokeWidth="7" fill="none" />
      <circle className="ra-stroke-brass-hi" cx="80" cy="56" r="34" strokeWidth="1.5" fill="none" />
    </g>
  )
}

function Mechadendrites({ glow }: { glow: string }): JSX.Element {
  return (
    <g>
      <g fill="none" strokeLinecap="round">
        {DENDRITES.map((d) => <path key={d} className="ra-stroke-steel" strokeWidth="7" d={d} />)}
        {DENDRITES.map((d) => <path key={d} className="ra-stroke-brass" strokeWidth="4" strokeDasharray="4 4" d={d} />)}
        <path className="ra-stroke-brass" strokeWidth="2.5" d="M24 40 l-5 -8 M24 40 l5 -8 M144 54 l-6 -6 M144 54 l3 -9" />
      </g>
      <circle className="ra-crimson-lit" cx="144" cy="144" r="6" filter={`url(#${glow})`} />
      <circle className="ra-void ra-stroke-brass" cx="144" cy="144" r="4.5" strokeWidth="2" />
      <circle className="ra-crimson-lit" cx="144" cy="144" r="2" />
    </g>
  )
}

function Robe({ robe }: { robe: string }): JSX.Element {
  return (
    <g>
      <path fill={`url(#${robe})`} d="M38 98 C30 116 26 134 24 156 L136 156 C134 134 130 116 122 98 Z" />
      <path className="ra-stroke-void" strokeWidth="2" fill="none" opacity="0.55" d="M58 110 C54 128 52 142 50 156 M102 110 C106 128 108 142 110 156" />
      <path className="ra-stroke-brass" strokeWidth="3" fill="none" d="M80 106 L80 156" />
      <path className="ra-stroke-brass" strokeWidth="3" fill="none" strokeLinecap="round" d="M38 98 Q80 116 122 98" />
      <g className="ra-brass">
        {CHEST_TEETH.map((angle) => <rect key={angle} x="78.5" y="110" width="3" height="4" transform={`rotate(${angle} 80 120)`} />)}
        <circle cx="80" cy="120" r="7" />
      </g>
      <circle className="ra-void" cx="80" cy="120" r="2.6" />
    </g>
  )
}

function Hood({ hood, glow }: { hood: string; glow: string }): JSX.Element {
  return (
    <g>
      <path fill={`url(#${hood})`} d="M80 24 C62 24 50 40 50 60 C50 74 46 86 38 98 L122 98 C114 86 110 74 110 60 C110 40 98 24 80 24 Z" />
      <path className="ra-stroke-void" strokeWidth="2" fill="none" opacity="0.45" d="M58 54 C56 70 52 84 46 94 M102 54 C104 70 108 84 114 94" />
      <path className="ra-void ra-stroke-brass" strokeWidth="2.5" d="M80 40 C69 40 63 50 63 62 C63 74 68 84 74 90 L86 90 C92 84 97 74 97 62 C97 50 91 40 80 40 Z" />
      <circle className="ra-steel" cx="72" cy="61" r="2.2" />
      <circle className="ra-crimson-lit" cx="86" cy="60" r="7" filter={`url(#${glow})`} />
      <circle className="ra-void ra-stroke-brass" cx="86" cy="60" r="5.5" strokeWidth="2" />
      <circle className="ra-crimson-lit" cx="86" cy="60" r="3.2" />
      <circle className="ra-ink" cx="87.2" cy="58.8" r="1.1" />
      <rect className="ra-steel" x="72" y="71" width="16" height="11" rx="2" />
      <path className="ra-stroke-void" strokeWidth="1.4" d="M74 74 H86 M74 76.8 H86 M74 79.6 H86" />
      <path className="ra-stroke-steel" strokeWidth="2.5" fill="none" strokeLinecap="round" d="M73 80 C69 84 66 86 63 86 M87 80 C91 84 94 86 97 86" />
    </g>
  )
}

/**
 * The Magos: a hooded tech-priest under a cog halo, one glowing optic in the shadow of the hood and mechadendrites
 * curling from behind the shoulders. Original vector art; every colour is a theme token set in agentRoles.css.
 */
export function MagosArt({ size = 160 }: ArtProps): JSX.Element {
  const ids = useArtIds()
  return (
    <svg className="role-art" viewBox="0 0 160 160" width={size} height={size} role="img" aria-label="Magos: a hooded tech-priest with a cog halo">
      <ArtDefs ids={ids} blur={3} />
      <CogHalo />
      <Mechadendrites glow={ids.glow} />
      <Robe robe={ids.robe} />
      <Hood hood={ids.hood} glow={ids.glow} />
    </svg>
  )
}
