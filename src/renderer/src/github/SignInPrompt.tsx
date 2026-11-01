import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { useGithub } from './GithubAccount'

interface SignInPromptProps {
  /** What signing in is for, completing "Sign in to GitHub to …", e.g. "push this branch". */
  purpose: string
}

/** An inline card asking the person to sign in to GitHub; Sign in opens the app-wide sign-in dialog. */
export function SignInPrompt({ purpose }: SignInPromptProps): JSX.Element {
  const { openSignIn } = useGithub()
  return (
    <div className="sign-in-prompt">
      <Icon name="github" size={18} />
      <p className="sign-in-prompt-text">{`Sign in to GitHub to ${purpose}`}</p>
      <Button size="sm" variant="primary" onClick={openSignIn}>
        Sign in
      </Button>
    </div>
  )
}
