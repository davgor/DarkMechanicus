import { z } from 'zod'

/**
 * An epic branch name: a subset of git check-ref-format (no whitespace or ~^:?*[\, no leading dash, "..", "@{",
 * trailing "/", "." or ".lock"). The server's schemas and the desktop's Start run dialog share it, so it must stay
 * free of Node-only imports.
 */
export const epicBranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*(?:\/|\.|\.lock)$)[^\s~^:?*[\\]+$/, 'Not a valid branch name')
