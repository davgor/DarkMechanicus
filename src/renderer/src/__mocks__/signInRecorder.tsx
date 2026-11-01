/**
 * The shell's `SignInContext` for component tests: records each sign-in view a Sign in button asked for, and plays the
 * view's end (the status checked once the CLI's login ended) back to the screen that asked. Not shipped.
 */
import type { ReactNode } from 'react'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { SignInContext, type SignInRequest } from '../agents/signInContext'

export class SignInRecorder {
  /** Every sign-in view asked for, oldest first. */
  readonly requests: SignInRequest[] = []

  private readonly open = (request: SignInRequest): void => {
    this.requests.push(request)
  }

  /** `ui` with Sign in opening the recorded view. */
  wrap(ui: ReactNode): JSX.Element {
    return <SignInContext.Provider value={this.open}>{ui}</SignInContext.Provider>
  }

  /** The agents the views were asked for, oldest first. */
  agents(): string[] {
    return this.requests.map((request) => request.agent)
  }

  /** The latest view's login ended and the status said `status`, as the view reports it. */
  finish(status: AgentAuthStatus): void {
    const request = this.requests.at(-1)
    if (request === undefined) throw new Error('no sign-in view was opened')
    request.onStatus?.(status)
    if (status.state === 'signed_in') request.onSignedIn?.()
  }
}
