/**
 * The one OMP module the extension imports. OMP's own runtime resolves it when it loads the extension (its loader
 * rewrites host-package imports; a specifier held in a variable is not rewritten, so the import must be a literal);
 * the app's type check and tests have no OMP package, so this declares just the part used.
 */
declare module '@oh-my-pi/pi-coding-agent/config/registry' {
  export function lookup(id: string): { get: (scope: unknown) => unknown } | undefined
}
