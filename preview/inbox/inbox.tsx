import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import './preview.css'
import { browserScheduler } from '../../src/renderer/src/app/scheduler'
import { TerminalPane } from '../../src/renderer/src/agents/TerminalPane'
import { createLiveTerminals, LiveTerminalsContext } from '../../src/renderer/src/agents/liveTerminals'
import { AgentMailContext, createAgentMailStore } from '../../src/renderer/src/agents/useAgentMail'
import { xtermKit } from '../../src/renderer/src/agents/xtermKit'
import { ChatRow } from '../../src/renderer/src/sidebar/ChatRow'
import { FakeChatMail, mailMessage } from '../../src/renderer/src/__mocks__/fakeChatMail'
import { FakeDm } from '../../src/renderer/src/__mocks__/fakeDm'
import { FakeTerminals } from '../../src/renderer/src/__mocks__/fakeTerminals'
import { chatRecord } from '../../src/renderer/src/__mocks__/fixtures'

/**
 * The real Messages action, sidebar rows and inbox dialog over a real xterm, against the renderer test fakes
 * (`window.dm` with an in-memory mailbox), for a visual check of DM-513 without the installed app.
 */
const FOLDER = '/home/u/code/alpha'
const LEAD = chatRecord({ id: 'chat_lead', folder: FOLDER, title: 'Skitarii lead', agent: 'omp', endpointId: 'ep_lead' })
const REVIEWER = chatRecord({ id: 'chat_rev', folder: FOLDER, title: 'Skitarii reviewer', agent: 'omp', endpointId: 'ep_rev' })
const STOPPED = chatRecord({ id: 'chat_doc', folder: FOLDER, title: 'Docs scribe (stopped)', agent: 'omp', endpointId: 'ep_doc' })

const mail = new FakeChatMail()
mail.put({ folder: FOLDER, chatId: 'chat_lead', humanSeenSeq: 1, unseenCount: 2, pendingCount: 2, retainedCount: 3 })
mail.put({ folder: FOLDER, chatId: 'chat_doc', unseenCount: 4, pendingCount: 4, retainedCount: 4 })
mail.put({ folder: FOLDER, chatId: 'chat_rev' })
mail.setMessages(FOLDER, 'chat_lead', [
  mailMessage({ seq: 1, from: { endpointId: 'ep_rev', name: 'Skitarii reviewer', deleted: false }, acknowledgedAt: '2026-11-15T10:05:00.000Z', body: 'Review of DM-513 started.' }),
  mailMessage({ seq: 2, from: { endpointId: 'ep_doc', name: 'Docs scribe (stopped)', deleted: false }, inReplyTo: 'msg_sent_4', acceptedAt: '2026-11-15T10:20:00.000Z', body: 'Docs updated as you asked.' }),
  mailMessage({
    seq: 3,
    from: { endpointId: 'ep_x', name: 'Unknown <b>agent</b>', deleted: true },
    acceptedAt: '2026-11-15T10:31:00.000Z',
    body: 'Hostile text stays inert: \x1b]8;;https://evil.example\x07click me\x1b]8;;\x07 <img src=x onerror="alert(1)"> \u202Eevil\x1b[2J'
  })
])

const dm = new FakeDm()
const terminals = new FakeTerminals()
terminals.screens.chat_lead = '\x1b[38;5;179mSkitarii\x1b[0m ready. Waiting for input.\r\n> '
dm.terminals = terminals
dm.chats.mail = mail
window.dm = dm
const store = createAgentMailStore(mail)
mail.onEvent(store.push)
store.track([FOLDER])

function Preview(): JSX.Element {
  const [live] = useState(createLiveTerminals)
  return (
    <AgentMailContext.Provider value={store}>
      <LiveTerminalsContext.Provider value={live}>
        <div className="app-shell preview-inbox">
          <aside className="sidebar" aria-label="Tracked folders">
            <ul className="chat-list">
              {[LEAD, REVIEWER, STOPPED].map((chat) => (
                <li key={chat.id}>
                  <ChatRow chat={chat} agents={[]} signInWaiting={false} selected={chat.id === LEAD.id} onOpen={() => undefined} onRename={() => undefined} onDelete={() => undefined} />
                </li>
              ))}
            </ul>
          </aside>
          <main className="app-main" aria-label="Workspace">
            <TerminalPane folder={FOLDER} chat={LEAD} agentName="Skitarii" kit={xtermKit} scheduler={browserScheduler} peers={[LEAD, REVIEWER, STOPPED]} onOpenChat={() => undefined} />
          </main>
        </div>
      </LiveTerminalsContext.Provider>
    </AgentMailContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
