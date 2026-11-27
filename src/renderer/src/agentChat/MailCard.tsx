/**
 * One Skitarii message a chat received or sent, as a card in its GUI transcript. The body is another agent's plain
 * text: never Markdown, links or markup, its terminal sequences and direction overrides shown as visible marks, claim
 * tokens masked (main masked them first), and clipped until the person asks for all of it.
 */
import { useState } from 'react'
import { maskClaimTokens } from '../../../core/claimTokenMask'
import type { ChatMailEntry, ChatMailParty } from '../../../shared/agents/chatApi'
import { inertText } from '../agents/inertText'
import './mailCard.css'

/** Characters of a body shown before "Show all". */
export const MAIL_CARD_CLIP = 4000

/** A callsign as itself; a stored mailbox name (a chat outside the epic) marked as a name. */
function Party({ party }: { party: ChatMailParty }): JSX.Element {
  const label = inertText(party.label)
  return party.kind === 'callsign' ? <span className="chat-mail-party">{label}</span> : (
    <span className="chat-mail-party is-name" title="Chat name, not a callsign">
      “{label}” <span className="chat-mail-name-tag">(name)</span>
    </span>
  )
}

export function MailCard({ mail }: { mail: ChatMailEntry }): JSX.Element {
  const [all, setAll] = useState(false)
  const body = inertText(maskClaimTokens(mail.body))
  const long = body.length > MAIL_CARD_CLIP
  const direction = mail.direction === 'received' ? 'Received' : 'Sent'
  return (
    <li className={`chat-mail chat-mail-${mail.direction}`}>
      <article className="chat-mail-card" aria-label={`${direction} mail`}>
        <p className="chat-mail-head">
          <span aria-hidden="true">✉</span> <Party party={mail.from} /> <span aria-label="to">→</span> <Party party={mail.to} />{' '}
          <span className="chat-mail-direction">{direction}</span>
        </p>
        {mail.inReplyTo === null ? null : <p className="chat-mail-reply">Reply to <code>{inertText(mail.inReplyTo)}</code></p>}
        <p className="chat-mail-body">{long && !all ? `${body.slice(0, MAIL_CARD_CLIP)}…` : body}</p>
        {long && !all ? <button type="button" className="btn btn-sm chat-mail-more" onClick={() => setAll(true)}>Show all</button> : null}
      </article>
    </li>
  )
}
