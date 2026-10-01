import type { ButtonHTMLAttributes } from 'react'
import { classNames } from './classNames'
import { Icon } from './Icon'
import type { IconName } from './Icon'

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

const VARIANT_CLASS: Record<ButtonVariant, string | false> = {
  default: false,
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  danger: 'btn-danger'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: IconName
  /** Shows the button as working: disabled, with `aria-busy`. */
  busy?: boolean
}

interface ClassOptions {
  variant: ButtonVariant
  small: boolean
  iconOnly: boolean
  extra: string | undefined
}

function buttonClass(options: ClassOptions): string {
  return classNames(
    'btn',
    VARIANT_CLASS[options.variant],
    options.small && 'btn-sm',
    options.iconOnly && 'btn-icon',
    options.extra
  )
}

/** Icon-only buttons show their accessible name as a tooltip unless a title is given. */
function tooltip(iconOnly: boolean, title: string | undefined, label: string | undefined): string | undefined {
  if (title !== undefined) {
    return title
  }
  return iconOnly ? label : undefined
}

/** A real <button>: icon and label are optional, and without a label it is an icon button. */
export function Button(props: ButtonProps): JSX.Element {
  const { variant = 'default', size, icon, busy, className, children, disabled, type, title, ...rest } = props
  const iconOnly = icon !== undefined && children === undefined
  const classes = buttonClass({ variant, small: size === 'sm', iconOnly, extra: className })
  return (
    <button
      {...rest}
      type={type ?? 'button'}
      title={tooltip(iconOnly, title, props['aria-label'])}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {children === undefined ? null : <span>{children}</span>}
    </button>
  )
}
