type ClassPart = string | false | null | undefined

/** Joins the truthy class names with single spaces. */
export function classNames(...parts: ClassPart[]): string {
  return parts.filter(Boolean).join(' ')
}
