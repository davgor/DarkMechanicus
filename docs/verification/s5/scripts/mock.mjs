// Mock OpenAI-compatible streaming server for OMP: every chat completion streams a slow canned reply.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
const port = Number(process.argv[2] ?? 18405)
const log = process.argv[3]
const delay = Number(process.env.MOCK_DELAY_MS ?? 250)
const reply = () => 'Skitarii acceptance reply. 宽字符 日本語のテキスト 한국어 漢字 ｗｉｄｅ. Emoji: 🛠️ ⚙️ 👍🏽 🦾 🔥. Brass **bold**, `inline code`, and a [link](https://example.com).\n\n- first item 工具\n- second item ✅\n\n```js\nconst cog = 42 // true colour code\n```'
let turns = 0
createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  if (log) appendFileSync(log, `${new Date().toISOString()} ${req.method} ${req.url} ${body.length}\n`)
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }))
    return
  }
  turns += 1
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const id = `chatcmpl-${turns}`
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  chunk({ role: 'assistant', content: '' })
  for (const word of reply().split(' ')) {
    chunk({ content: word + ' ' })
    await new Promise((r) => setTimeout(r, delay))
  }
  chunk({}, 'stop')
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}).listen(port, '127.0.0.1', () => console.log('mock listening', port))
