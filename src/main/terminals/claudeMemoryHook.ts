/**
 * The `PreToolUse` command hook a chat terminal's Claude Code runs before a file write (registered by
 * `claudeSettingsFile.ts`, built to `out/main/claudeMemoryHook.js`). It reads the call's JSON on its standard
 * input and prints the ask answer for a write into a memory folder, or nothing, which leaves the call to the CLI's
 * own permission rules (`claudeMemoryGuard.ts`). Its arguments are the chat folder, the home folder and the temp
 * folder main wrote into the hook command; its environment is the CLI's.
 */
import { memoryHookOutput } from './claudeMemoryGuard'

const chunks: Buffer[] = []
const answer = (): void => {
  process.stdout.write(memoryHookOutput(process.argv.slice(2), Buffer.concat(chunks).toString('utf8'), process.env, process.platform))
}
process.stdin.on('data', (chunk: Buffer) => {
  chunks.push(chunk)
})
process.stdin.on('end', answer)
// An input that cannot be read is answered as one that is not JSON: the call asks.
process.stdin.on('error', () => {
  chunks.length = 0
  answer()
})
