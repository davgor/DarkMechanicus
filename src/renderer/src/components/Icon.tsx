import { classNames } from './classNames'

/** 16×16 stroke icons, drawn inline so they follow `currentColor` and need no asset loading. */
const ICON_PATHS = {
  hex: 'M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5zM8 6v4M6.2 7l3.6 2',
  'chevron-down': 'M4 6l4 4 4-4',
  'chevron-right': 'M6 4l4 4-4 4',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  plus: 'M8 3v10M3 8h10',
  warning: 'M8 2.5l6 11H2zM8 6.5v3M8 11.5h.01',
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
  download: 'M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10'
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
