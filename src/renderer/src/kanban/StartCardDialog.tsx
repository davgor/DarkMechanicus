import { useState } from 'react'
import type { StartKanbanCardResult } from '../../../shared/agents/chatApi'
import { errorMessage } from '../api/dm'
import { unwrapChat } from '../agents/chatCalls'
import { useAgentModelChoice } from '../agents/useAgentModelChoice'
import { useFolderDefaultAgent } from '../agents/useFolderDefaultAgent'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { RunWithAgentSection } from '../epic/StartRunDialog'
import type { OrchestrationHost } from '../epic/orchestration'

interface StartCardDialogProps {
  folderPath: string
  card: { id: string; key: string; title: string }
  host: OrchestrationHost
  /** Play went through: the card as it left it, and the chat when an agent was started. */
  onStarted(result: StartKanbanCardResult): void
  onClose(): void
}

const DESCRIPTION = 'Choose the agent that carries this card. It works in a chat you can follow, then submits the card for your review.'

/**
 * Play: pick a connected, signed-in agent and its model. Dark Mechanicus marks the play and starts that
 * agent in a chat of this folder to carry the card to Ready for review. A refusal keeps the dialog open
 * and says why.
 */
export function StartCardDialog({ folderPath, card, host, onStarted, onClose }: StartCardDialogProps): JSX.Element {
  const preferred = useFolderDefaultAgent(folderPath)
  const choice = useAgentModelChoice(host.agents, host.statuses, preferred.agentId)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { agent } = choice
  const start = async (): Promise<void> => {
    if (agent === null) return
    setBusy(true)
    setProblem(null)
    try {
      onStarted(await unwrapChat(window.dm.chats.startKanbanCard({ folder: folderPath, cardId: card.id, agent, model: choice.model })))
    } catch (error) {
      setProblem(errorMessage(error))
      setBusy(false)
    }
  }
  const actions = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={agent === null || !preferred.loaded || !choice.valid || busy} busy={busy} onClick={() => void start()}>
        Start
      </Button>
    </>
  )
  return (
    <Dialog title={`Play ${card.key}`} description={DESCRIPTION} onClose={onClose} actions={actions}>
      <div className="form">
        <RunWithAgentSection
          {...host}
          hint={`Dark Mechanicus starts the agent on “${card.title}” and sends it the card. It cannot save plans.`}
          choice={choice}
          onAddAgent={() => {
            onClose()
            host.onAddAgent()
          }}
        />
        {problem === null ? null : (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}
