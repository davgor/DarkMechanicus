/**
 * The `{folder}` rule of a custom CLI's stored arguments: an argument that is exactly `{folder}` becomes the
 * chat's canonical folder (as `resolveLaunchFolder` returned it). One that holds `{folder}` inside a longer
 * string is refused, so a folder never has to be spliced into, or quoted inside, a larger argument. Adding a
 * custom CLI checks its arguments with it (`customAgent.ts`); a chat's terminal applies the same rule
 * (`terminalLaunchSpec.ts`).
 */

const FOLDER_PLACEHOLDER = '{folder}'

/** `args` with each whole `{folder}` replaced by `folder`; throws for one that holds it inside a longer string. */
export function withFolder(args: readonly string[], folder: string): string[] {
  return args.map((arg) => {
    if (arg === FOLDER_PLACEHOLDER) {
      return folder
    }
    if (arg.includes(FOLDER_PLACEHOLDER)) {
      throw new Error(`The argument ${JSON.stringify(arg)} holds {folder} inside other text; {folder} must be an argument of its own.`)
    }
    return arg
  })
}
