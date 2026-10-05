/**
 * A chat transcript file as the app wrote it before nested threads existed (the Agents sprint 1
 * contract): one JSON line per item, a tool call written twice (`running`, then `completed`, the later
 * line replacing the earlier), no `thread` item, no `threadId` and no `threadLabel` anywhere. The chat is
 * a Claude chat in which the agent started two subagents; sprint 1 left their inner work out, so all the
 * transcript has of them is the two Agent calls and the Write request one of them raised, which was
 * recorded like any other approval. Not shipped.
 */
export const CHAT_BEFORE_THREADS_LINES: readonly string[] = [
  '{"id":"it_1","at":"2026-01-01T00:00:01.000Z","kind":"user_message","text":"Summarize a.txt and b.txt with two subagents"}',
  '{"id":"claude_tool_toolu_old1","at":"2026-01-01T00:00:02.000Z","kind":"tool_call","name":"Agent","input":{"description":"Summarize a.txt","subagent_type":"file-reader","prompt":"Read a.txt and summarize it."},"status":"running","resultSummary":null}',
  '{"id":"claude_tool_toolu_old2","at":"2026-01-01T00:00:02.000Z","kind":"tool_call","name":"Agent","input":{"description":"Summarize b.txt","subagent_type":"file-reader","prompt":"Read b.txt, summarize it and save the summary."},"status":"running","resultSummary":null}',
  '{"id":"claude_approval_toolu_oldw","at":"2026-01-01T00:00:03.000Z","kind":"approval_request","requestId":"toolu_oldw","category":"file_edit","tool":"Write","summary":"Write /work/repo/summary-b.txt","input":{"file_path":"/work/repo/summary-b.txt","content":"Beta lists three tools."}}',
  '{"id":"item_dec_1","at":"2026-01-01T00:00:04.000Z","kind":"approval_decision","requestId":"toolu_oldw","decision":"allow_once"}',
  '{"id":"claude_tool_toolu_old1","at":"2026-01-01T00:00:02.000Z","kind":"tool_call","name":"Agent","input":{"description":"Summarize a.txt","subagent_type":"file-reader","prompt":"Read a.txt and summarize it."},"status":"completed","resultSummary":"Alpha lists three fruits."}',
  '{"id":"claude_tool_toolu_old2","at":"2026-01-01T00:00:02.000Z","kind":"tool_call","name":"Agent","input":{"description":"Summarize b.txt","subagent_type":"file-reader","prompt":"Read b.txt, summarize it and save the summary."},"status":"completed","resultSummary":"Beta lists three tools."}',
  '{"id":"claude_msg_old_0","at":"2026-01-01T00:00:05.000Z","kind":"assistant_text","text":"Alpha lists three fruits and beta lists three tools."}'
]

/** The file's text: the lines, each ended by a newline. */
export const CHAT_BEFORE_THREADS = `${CHAT_BEFORE_THREADS_LINES.join('\n')}\n`
