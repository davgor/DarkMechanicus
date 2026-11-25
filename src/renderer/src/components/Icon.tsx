import { classNames } from './classNames'

/** 16×16 stroke icons, drawn inline so they follow `currentColor` and need no asset loading. */
const ICON_PATHS = {
  'list-checks': 'M2 4l1 1 2-2M7 4h7M2 8l1 1 2-2M7 8h7M2 12l1 1 2-2M7 12h7',
  circle: 'M8 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  'circle-dashed': 'M8 2a6 6 0 0 1 3 0.8M13.2 5a6 6 0 0 1 0.8 3M13.2 11a6 6 0 0 1-2.2 2.2M8 14a6 6 0 0 1-3-0.8M2.8 11A6 6 0 0 1 2 8M2.8 5A6 6 0 0 1 5 2.8',
  pause: 'M5 3v10M11 3v10',
  'chevron-down': 'M4 6l4 4 4-4',
  'chevron-right': 'M6 4l4 4-4 4',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  agent: 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5',
  plus: 'M8 3v10M3 8h10',
  warning: 'M8 2.5l6 11H2zM8 6.5v3M8 11.5h.01',
  bell: 'M3 11.5h10l-1.5-2V7a3.5 3.5 0 0 0-7 0v2.5zM6.5 13.5a1.7 1.7 0 0 0 3 0',
  plug: 'M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14',
  export: 'M2 8h3.5M10.5 8H14M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.5-3.5',
  check: 'M3 8.5l3 3 7-7',
  close: 'M4 4l8 8M12 4l-8 8',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
  branch: 'M5 2.5v7M11 3.5v1.5a2 2 0 0 1-2 2H6.5M5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  'arrow-up': 'M8 13V3M4 7l4-4 4 4',
  download: 'M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10',
  kanban: 'M2.5 3h3v10h-3zM6.5 3h3v6h-3zM10.5 3h3v8h-3z',
  hourglass: 'M4 2h8M4 14h8M5 2v2.5L8 8l-3 3.5V14M11 2v2.5L8 8l3 3.5V14',
  lock: 'M4 7.5h8v6H4zM5.5 7.5v-2a2.5 2.5 0 0 1 5 0v2',
  /** A bar chart: the Metrics dashboard. */
  chart: 'M2.5 13.5h11M4.5 11V8.5M8 11V4M11.5 11V6.5',
  /** A gear: the app Settings screen. */
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  /** The GitHub mark (Octocat silhouette), drawn as an outline. */
  github:
    'M6 13c-3 .9-3-1.5-4.2-1.8M10.2 14.5v-2.3c0-.7-.1-1.2-.5-1.6 1.7-.2 3.5-.8 3.5-3.8a3 3 0 0 0-.8-2 2.7 2.7 0 0 0-.1-2s-.6-.2-2.1.8a7.3 7.3 0 0 0-3.8 0C4.9 2.6 4.3 2.8 4.3 2.8a2.7 2.7 0 0 0-.1 2 3 3 0 0 0-.8 2c0 3 1.8 3.6 3.5 3.8-.4.4-.5.9-.5 1.6v2.3'
} as const

export type IconName = keyof typeof ICON_PATHS

interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}

export function Icon({ name, size = 16, strokeWidth = 1.6, className }: IconProps): JSX.Element {
  return (
    <svg
      className={classNames('icon', className)}
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}
