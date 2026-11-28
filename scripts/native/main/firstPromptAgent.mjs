/** Disposable custom CLI for the first-prompt desktop proof. Its selected OMP model, not this fixture, infers the title. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createDmClient, DM_CLIENT_DESCRIPTOR_ENV, nodeDmClientDeps } from '../../../resources/skitarii/extension/dmClient.ts'
import { writeDmClientDescriptor } from '../../../src/main/terminals/terminalFiles.ts'

const [instructionsPath, evidence, descriptorRoot, cliRuntime, cliScript] = process.argv.slice(2)
const instructions = readFileSync(instructionsPath, 'utf8')
const report = (event) => appendFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event }) + '\n')
let native
async function naming(args) {
  if (!native) {
    // Custom CLIs do not receive an OMP descriptor. This private fixture descriptor routes only;
    // the real app-issued token still authenticates the actual live chat and generation.
    const descriptor = await writeDmClientDescriptor({
      userData: descriptorRoot, chatId: 'ch_native_smoke', generation: randomUUID(), folder: process.cwd(), platform: process.platform,
      cli: {
        command: cliRuntime, args: [cliScript, '--repo', process.cwd()],
        env: { ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: process.env.DARKMECHANICUS_HOME }
      }
    })
    native = createDmClient({ ...nodeDmClientDeps(), env: { ...process.env, [DM_CLIENT_DESCRIPTOR_ENV]: descriptor } })
  }
  return native.run('name_chat', args)
}
async function infer(prompt) {
  const system = `${instructions}\n\nThis custom CLI owns the metadata transport. Return ONLY a JSON object {"title":"your semantic intent label"} (or {"error":"real inference problem"}). Do not run commands or solve the user's task; the CLI sends your inferred result through name_chat. Read the full unmodified user message to infer intent. Never copy the instruction's example title.`
  const env = { ...process.env }
  delete env.DM_SESSION_TOKEN
  delete env.DM_DESKTOP_PIPE
  delete env.DM_BROWSER_PIPE
  delete env.ELECTRON_RUN_AS_NODE
  const args = ['-p', '--model', process.env.DM515_MODEL, '--thinking', 'minimal', '--no-tools', '--no-session', '--no-title', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--max-time', '90', '--max-cost', '1', '--system-prompt', system, prompt]
  report({ event: 'model-request', model: process.env.DM515_MODEL, prompt, instructionsPath })
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DM515_OMP, args, { env, cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => {
      writeFileSync(`${evidence}.model-output.txt`, stdout)
      writeFileSync(`${evidence}.model-stderr.txt`, stderr)
      if (code !== 0) return reject(new Error(`Selected model exited with code ${code}; inspect isolated model stderr.`))
      try {
        const candidate = stdout.match(/\{\s*"(?:title|error)"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/u)?.[0]
        if (!candidate) throw new Error('Selected model returned no title result.')
        resolve(JSON.parse(candidate))
      } catch (error) { reject(error) }
    })
  })
}
async function firstMessage(prompt) {
  try {
    const result = await infer(prompt)
    report({ event: 'model-result', result })
    const reply = await naming(result)
    report({ event: 'title-reply', transport: 'native-dm-client', reply })
    process.stdout.write(`Title inference ${reply.ok ? 'reported' : 'refused'}.\r\n> `)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    report({ event: 'inference-failed', message })
    await naming({ error: message.slice(0, 256) }).catch(() => {})
    process.stdout.write(`Title inference failed: ${message}\r\n> `)
  }
}
let text = '', paste = false, first = true, sequence = ''
function receivedMessage(prompt) {
  report({ event: first ? 'first-message' : 'later-message', prompt })
  process.stdout.write(`\r\nReceived ${first ? 'full first prompt' : 'terminal turn'}: ${prompt}\r\n`)
  if (first) {
    first = false
    void firstMessage(prompt)
  }
}
process.stdin.setRawMode?.(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  sequence += chunk
  while (sequence.length) {
    if (sequence.startsWith('\x1b[200~')) { paste = true; sequence = sequence.slice(6); continue }
    if (sequence.startsWith('\x1b[201~')) { paste = false; sequence = sequence.slice(6); continue }
    if (sequence[0] === '\x1b' && sequence.length < 6) return
    const char = sequence[0]; sequence = sequence.slice(1)
    if (char === '\r' && !paste) {
      const prompt = text; text = ''
      receivedMessage(prompt)
    } else if (char === '\x03') process.exit(0)
    else text += char === '\r' ? '\n' : char
  }
})
report({ event: 'ready', instructionsPath, namingRequested: instructions.includes('## First-message chat naming') })
process.stdout.write('\x1b[?2004hDisposable semantic agent ready.\r\n> ')
