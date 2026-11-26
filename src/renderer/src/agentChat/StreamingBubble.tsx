import { Markdown } from '../markdown/Markdown'

/** Ephemeral text; the model removes this bubble when its durable item arrives. */
export function StreamingBubble({ text, thinking }: { text: string; thinking: string }): JSX.Element {
  return (
    <article className="agent-chat-stream" aria-label="Assistant streaming" aria-busy="true">
      <p className="chat-msg-who">Assistant · working</p>
      {thinking && <details className="agent-chat-thinking"><summary>Thinking</summary><Markdown source={thinking} /></details>}
      {text && <Markdown source={text} />}
    </article>
  )
}
