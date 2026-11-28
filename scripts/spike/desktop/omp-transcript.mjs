/**
 * DM-1041 throwaway: redacts and summarizes the RPC frames `omp-computer-probe.mjs` captured. Redaction replaces every
 * image payload with a fixed placeholder, masks tokens and keys, and replaces the home folder and probe temp roots, so
 * the result can be committed as a fixture for the build sprint's fake CLI. The summary lists the tool calls, the
 * `/computer status` output, the PROBE_RESULT line and every pixel coordinate the agent's code sent. Imported by no
 * product code.
 */
import { writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { inside } from './fixture.mjs'

const IMAGE = '<image:redacted-by-dm1041>'
const SECRETS = [
  /sk-[A-Za-z0-9_-]{16,}/gu, /gh[pousr]_[A-Za-z0-9]{20,}/gu, /\bat_[0-9a-z]{26}\.[A-Za-z0-9]{20,}/gu,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gu, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu
]
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const PATHS = [[homedir(), '<HOME>'], [tmpdir(), '<TMP>']].flatMap(([path, label]) => [
  [new RegExp(escape(path), 'giu'), label], [new RegExp(escape(path.replaceAll('\\', '/')), 'giu'), label],
  [new RegExp(escape(path.replaceAll('\\', '\\\\')), 'giu'), label]
])

function redactString(text) {
  let out = text
  for (const pattern of SECRETS) out = out.replace(pattern, '<token:redacted>')
  for (const [pattern, label] of PATHS) out = out.replace(pattern, label)
  if (out.length > 4096 && /^[A-Za-z0-9+/=\s]+$/u.test(out)) return IMAGE
  return out
}

function redactObject(value) {
  const copy = {}
  for (const [name, entry] of Object.entries(value)) copy[name] = name === 'apiKey' ? '<token:redacted>' : redact(entry, name)
  if (copy.type === 'image' && typeof copy.data === 'string') copy.data = IMAGE
  return copy
}

/** Deep copy with every image payload and secret replaced. */
export function redact(value, key = '') {
  if (typeof value === 'string') return key === 'data' && value.length > 256 ? IMAGE : redactString(value)
  if (Array.isArray(value)) return value.map((entry) => redact(entry))
  return value && typeof value === 'object' ? redactObject(value) : value
}

const textOf = (content) => (Array.isArray(content) ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : String(content ?? ''))
const imagesIn = (value) => JSON.stringify(value ?? null).split('"type":"image"').length - 1

function toolEvents(frames) {
  const calls = []
  for (const { at, frame } of frames) {
    if (frame.type === 'tool_execution_start') calls.push({ at, phase: 'start', tool: frame.toolName, id: frame.toolCallId, args: frame.args })
    if (frame.type === 'tool_execution_end') calls.push({ at, phase: 'end', tool: frame.toolName, id: frame.toolCallId, isError: frame.isError ?? false, images: imagesIn(frame.result), text: textOf(frame.result?.content).slice(0, 4000) })
  }
  return calls
}

/** Pixel input the agent's eval code sent: `x.click(a, b` and friends, with the receiver named. */
function pixelCalls(calls) {
  const found = []
  for (const call of calls.filter((entry) => entry.phase === 'start' && entry.tool === 'eval')) {
    const code = JSON.stringify(call.args ?? {})
    for (const match of code.matchAll(/(\w+)\.(click|doubleClick|move|scroll|drag)\(\s*([\w.+\-*/ ()]+?)\s*,\s*([\w.+\-*/ ()]+?)\s*[,)]/gu)) {
      found.push({ receiver: match[1], method: match[2], x: match[3], y: match[4] })
    }
  }
  return found
}

function probeResult(calls) {
  for (const call of calls.filter((entry) => entry.phase === 'end')) {
    const line = call.text.split('\n').find((entry) => entry.startsWith('PROBE_RESULT'))
    if (line) { try { return JSON.parse(line.slice('PROBE_RESULT'.length).trim()) } catch { return { unparsed: line } } }
  }
  return null
}

export function summarize(frames, redactedPath) {
  writeFileSync(redactedPath, frames.map((entry) => JSON.stringify(redact(entry))).join('\n') + '\n')
  const calls = toolEvents(frames)
  const types = {}
  for (const { dir, frame } of frames) types[`${dir}:${frame.type}`] = (types[`${dir}:${frame.type}`] ?? 0) + 1
  return {
    frameTypes: types,
    toolNames: [...new Set(calls.map((call) => call.tool))],
    calls: calls.map((call) => redact(call)),
    commandOutput: frames.filter(({ frame }) => frame.type === 'command_output').map(({ frame }) => redact(frame)),
    configUpdates: frames.filter(({ frame }) => frame.type === 'config_update').map(({ frame }) => redact(frame)),
    pixelCalls: pixelCalls(calls),
    probeResult: probeResult(calls)
  }
}

/**
 * The agent's pixel click is window-relative (screenshot frame of the fixture window): it must lie inside the window
 * screenshot, and its desktop position (window origin plus the point) inside the fixture's physical bounds.
 */
export function coordinateChecks(summary, bounds) {
  const result = summary.probeResult
  const point = result?.clickPoint
  const size = result?.screenshotSize
  const win = result?.windowBounds
  if (!point || !size || !win || !bounds) return { checked: false, reason: 'PROBE_RESULT lacks clickPoint, screenshotSize or windowBounds', pixelCalls: summary.pixelCalls }
  const desktop = { x: (win.x ?? 0) + point.x, y: (win.y ?? 0) + point.y }
  return {
    checked: true,
    insideScreenshot: inside({ x: 0, y: 0, width: size.width, height: size.height }, point.x, point.y),
    desktopPoint: desktop,
    fixturePhysical: bounds.physical,
    insideFixture: inside(bounds.physical, desktop.x, desktop.y),
    pixelCalls: summary.pixelCalls
  }
}
