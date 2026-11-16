/** Orders strings by UTF-16 code unit (`<`), not by locale, so knowledge sorts the same on every machine. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
