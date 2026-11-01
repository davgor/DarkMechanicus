/**
 * zod probes for `new Function` when it builds an object schema, which the production CSP's `script-src 'self'`
 * blocks and reports as a violation. Without compiling, the page parses the same. Schemas are built as the
 * modules that define them load, so `main.tsx` imports this module before any other.
 */
import { config } from 'zod'

config({ jitless: true })
