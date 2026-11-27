import { type ArtProps, ArtDefs, useArtIds } from './artParts'

/** Text lines on the hanging scroll: [y, width]. */
const SCROLL_LINES = [[30, 22], [36, 18], [42, 24], [48, 16], [54, 22], [60, 20], [66, 12], [72, 22], [78, 17]] as const
/** Text lines on the data-slate's screen: [y, width]. */
const SLATE_LINES = [[110, 30], [115, 38], [120, 24], [125, 34], [130, 20]] as const
const QUILL_BARBS = 'M121 82 L127 79 M124 76 L131 72 M127 70 L134 65 M130 64 L137 58 M133 58 L139 51 M136 52 L141 45'
const SERVO_ARM = 'M112 92 L146 80 L124 88'
const LENSES = [76, 88]

function HangingScroll(): JSX.Element {
  return (
    <g>
      <circle className="ra-brass-soft" cx="84" cy="74" r="60" />
      <rect className="ra-bone" x="16" y="22" width="34" height="66" />
      <g className="ra-steel">
        {SCROLL_LINES.map(([y, width]) => <rect key={y} x="21" y={y} width={width} height="2" rx="1" />)}
      </g>
      <rect className="ra-brass" x="11" y="17" width="44" height="7" rx="3.5" />
      <rect className="ra-brass" x="11" y="86" width="44" height="7" rx="3.5" />
    </g>
  )
}

function RobeAndServoArm({ robe }: { robe: string }): JSX.Element {
  return (
    <g>
      <path fill={`url(#${robe})`} d="M46 94 C38 112 34 134 32 156 L132 156 C130 134 126 112 118 94 Z" />
      <path className="ra-stroke-bone" strokeWidth="2.5" fill="none" strokeLinecap="round" d="M46 94 Q82 110 118 94" />
      <path className="ra-stroke-steel" strokeWidth="7" fill="none" strokeLinecap="round" d={SERVO_ARM} />
      <path className="ra-stroke-brass" strokeWidth="3" fill="none" strokeLinecap="round" d={SERVO_ARM} />
      <circle className="ra-brass ra-stroke-void" cx="146" cy="80" r="4.5" strokeWidth="1.5" />
      <circle className="ra-brass ra-stroke-void" cx="112" cy="92" r="4.5" strokeWidth="1.5" />
    </g>
  )
}

function Hood({ hood, glow }: { hood: string; glow: string }): JSX.Element {
  return (
    <g>
      <path fill={`url(#${hood})`} d="M82 26 C70 32 58 44 56 62 C55 74 52 84 46 94 L118 94 C112 84 109 74 108 62 C106 44 94 32 82 26 Z" />
      <path className="ra-stroke-void" strokeWidth="2" fill="none" opacity="0.45" d="M62 56 C60 70 56 82 52 90 M102 56 C104 70 108 82 112 90" />
      <path className="ra-void ra-stroke-bone" strokeWidth="2.5" d="M82 44 C72 44 66 53 66 64 C66 74 70 82 76 88 L88 88 C94 82 98 74 98 64 C98 53 92 44 82 44 Z" />
      <path className="ra-stroke-brass" strokeWidth="1.6" d="M79.5 62 H84.5" />
      {LENSES.map((cx) => (
        <g key={cx}>
          <circle className="ra-brass-glow" cx={cx} cy="62" r="4" filter={`url(#${glow})`} />
          <circle className="ra-void ra-stroke-brass" cx={cx} cy="62" r="3.8" strokeWidth="1.8" />
          <circle className="ra-brass-glow" cx={cx} cy="62" r="1.7" />
        </g>
      ))}
      <path className="ra-stroke-steel" strokeWidth="1.6" strokeLinecap="round" d="M77 74 H87 M78 77.5 H86 M79 81 H85" />
    </g>
  )
}

function DataSlate({ glow }: { glow: string }): JSX.Element {
  return (
    <g>
      <path className="ra-stroke-crimson" strokeWidth="11" fill="none" strokeLinecap="round" d="M50 104 Q46 126 54 138 M114 104 Q118 124 108 136" />
      <g transform="rotate(-6 80 122)">
        <rect className="ra-brass" x="52" y="102" width="56" height="38" rx="3" />
        <rect className="ra-void" x="56" y="106" width="48" height="30" rx="1.5" />
        <g className="ra-brass-glow" filter={`url(#${glow})`} opacity="0.6">
          {SLATE_LINES.map(([y, width]) => <rect key={y} x="60" y={y} width={width} height="2" />)}
        </g>
        <g className="ra-brass-glow">
          {SLATE_LINES.map(([y, width]) => <rect key={y} x="60" y={y} width={width} height="2" rx="1" />)}
        </g>
      </g>
      <circle className="ra-steel" cx="55" cy="139" r="5" />
      <circle className="ra-steel" cx="107" cy="135" r="5" />
    </g>
  )
}

function Quill(): JSX.Element {
  return (
    <g>
      <path className="ra-bone" d="M119 88 C124 66 132 52 143 37 C142 54 136 72 124 91 Z" />
      <path className="ra-stroke-steel" strokeWidth="1" opacity="0.8" d={QUILL_BARBS} />
      <path className="ra-stroke-ink" strokeWidth="1.4" d="M101 111 L143 37" />
      <path className="ra-brass" d="M99 114 L102 106 L106 109 Z" />
      <rect className="ra-brass ra-stroke-void" x="117" y="84" width="10" height="7" rx="1.5" strokeWidth="1" transform="rotate(-30 122 87.5)" />
    </g>
  )
}

function RolledScrolls(): JSX.Element {
  return (
    <g>
      <g transform="rotate(-10 30 136)">
        <rect className="ra-bone" x="14" y="131" width="34" height="9" rx="4.5" />
        <rect className="ra-brass" x="11" y="130" width="5" height="11" rx="2" />
        <rect className="ra-brass" x="46" y="130" width="5" height="11" rx="2" />
      </g>
      <rect className="ra-bone" x="10" y="142" width="42" height="11" rx="5.5" />
      <rect className="ra-brass" x="7" y="141" width="6" height="13" rx="2.5" />
      <rect className="ra-brass" x="49" y="141" width="6" height="13" rx="2.5" />
      <rect className="ra-crimson" x="28" y="142" width="4" height="11" />
      <circle className="ra-crimson ra-stroke-brass" cx="30" cy="155" r="3.6" strokeWidth="1.2" />
    </g>
  )
}

/**
 * The Lexmechanic: a peak-hooded scribe-priest with twin brass lenses, holding a glowing data-slate while a servo arm
 * writes on it with a quill, before a hanging scroll and rolled scrolls. Original vector art; every colour is a theme
 * token set in agentRoles.css.
 */
export function LexmechanicArt({ size = 160 }: ArtProps): JSX.Element {
  const ids = useArtIds()
  return (
    <svg className="role-art" viewBox="0 0 160 160" width={size} height={size} role="img"
      aria-label="Lexmechanic: a scribe-priest with a data-slate, scrolls and a quill-servo arm">
      <ArtDefs ids={ids} blur={2} />
      <HangingScroll />
      <RobeAndServoArm robe={ids.robe} />
      <Hood hood={ids.hood} glow={ids.glow} />
      <DataSlate glow={ids.glow} />
      <Quill />
      <RolledScrolls />
    </svg>
  )
}
