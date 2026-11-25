/**
 * DM-938: the isolated branches a generated sprint learning card codifies guardrails on, and the read-only Git
 * verification of the manifests its submission names, modeled on `incrementVerify.ts`.
 *
 * Every affected repository's branch is `learnings/<cardKey>/<repo|root>`, rooted at the completed increment commit
 * the card's link row recorded (`sprint_learning_cards.bases_json`), so a retry of the card, a replayed claim or a
 * reclaim after a lost token always names the same branch. Verification only asks Git (`commitParents`,
 * `isAncestor`, `branchCommit`): it never merges, checks out or writes a ref.
 */
import type { LearningBranchManifest, VerifiedLearningManifest } from '../../shared/domain/kanban'
import type { SprintLearningCardView } from '../../shared/domain/learnings'
import { contentHash } from '../canonical'
import type { GitAdapter } from '../repo/types'

type Check = VerifiedLearningManifest['checks'][number]

const NAME = {
  covered: 'Manifest covers a recorded base',
  base: 'Names the recorded base',
  branch: 'Names the isolated branch',
  exists: 'Commit exists',
  descends: 'Descends from the base',
  tip: 'Matches the branch tip'
} as const

/** The branch-name segment of a repository: the child repository's name made safe for a ref, or `root`. */
function repoSegment(repo: string | null): string {
  if (repo === null) return 'root'
  const safe = repo.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '').replace(/\.lock$/i, '-lock')
  return safe === '' ? 'repo' : safe
}

/** The deterministic isolated branch of one card in one repository. */
export function learningBranchName(cardKey: string, repo: string | null): string {
  return `learnings/${cardKey}/${repoSegment(repo)}`
}

/** The one-line instruction that creates the branch in its own worktree, without touching the coordinating checkout. */
export function learningBranchInstruction(base: LearningIncrementBase, branch: string): string {
  const where = base.repo === null ? 'the repository' : `repository ${base.repo}`
  return (
    `In ${where}, run \`git worktree add -b ${branch} <new-worktree> ${base.commit}\` (the completed increment of ${base.branch}), ` +
    'commit the guardrails there and report the branch tip in learning.manifests; never check out, merge or push in the coordinating checkout.'
  )
}

const short = (commit: string): string => commit.slice(0, 7)
const check = (name: string, status: Check['status'], detail: string): Check => ({ name, status, detail })
const label = (repo: string | null): string => (repo === null ? 'the repository' : `repository ${repo}`)

type LearningIncrementBase = SprintLearningCardView['bases'][number]

/** The verdict on every manifest plus the coverage problems no single manifest shows. */
export interface LearningManifestProof {
  passed: boolean
  reasons: string[]
  manifests: VerifiedLearningManifest[]
  /** `contentHash` of the manifests as submitted, so the storing transaction stores only the submission it proved. */
  manifestsHash: string
  /** Rechecks each routed checkout's mapping inside the storing transaction, as a merge proof does. */
  assertCurrent(): void
}

/** The checks on what the manifest names, before the commit itself is asked about. */
function namingChecks(base: LearningIncrementBase, expectedBranch: string, manifest: LearningBranchManifest, resolvedBase: string | undefined): Check[] {
  return [
    check(NAME.covered, 'passed', `Covers the increment ${short(base.commit)} of ${label(base.repo)}.`),
    resolvedBase === base.commit
      ? check(NAME.base, 'passed', `Base ${short(base.commit)} is the recorded increment.`)
      : check(NAME.base, 'failed', `Base ${manifest.base} is not the recorded increment ${base.commit} of ${label(base.repo)}.`),
    manifest.branch === expectedBranch
      ? check(NAME.branch, 'passed', `Names ${expectedBranch}.`)
      : check(NAME.branch, 'failed', `Names branch "${manifest.branch}", but the card's isolated branch is "${expectedBranch}".`)
  ]
}

/** The commit exists, descends from the recorded base and is the named branch's tip. */
async function commitChecks(git: GitAdapter, base: LearningIncrementBase, manifest: LearningBranchManifest, commit: string | undefined): Promise<Check[]> {
  if (commit === undefined) {
    return [
      check(NAME.exists, 'failed', `Commit ${manifest.commit} was not found in ${label(base.repo)}.`),
      check(NAME.descends, 'skipped', 'The commit was not found.'),
      check(NAME.tip, 'skipped', 'The commit was not found.')
    ]
  }
  const descends = await git.isAncestor(base.commit, commit)
  const descendsDetail = {
    true: `Commit ${short(commit)} descends from ${short(base.commit)}.`,
    false: `Commit ${short(commit)} does not descend from the recorded base ${short(base.commit)}.`,
    null: `Git could not tell whether commit ${short(commit)} descends from ${short(base.commit)}.`
  }[String(descends) as 'true' | 'false' | 'null']
  const tip = git.branchCommit(manifest.branch)
  const tipDetail =
    tip === commit
      ? `${manifest.branch} points at ${short(commit)}.`
      : tip === null
        ? `Branch ${manifest.branch} was not found in ${label(base.repo)}.`
        : `${manifest.branch} points at ${short(tip)}, not ${short(commit)}.`
  return [
    check(NAME.exists, 'passed', `Commit ${short(commit)} exists.`),
    check(NAME.descends, descends === true ? 'passed' : 'failed', descendsDetail),
    check(NAME.tip, tip === commit ? 'passed' : 'failed', tipDetail)
  ]
}

async function verifyOne(
  git: GitAdapter,
  base: LearningIncrementBase,
  expectedBranch: string,
  manifest: LearningBranchManifest
): Promise<VerifiedLearningManifest> {
  const [named, resolvedBase] = await Promise.all([git.commitParents(manifest.commit), git.commitParents(manifest.base)])
  const checks = [
    ...namingChecks(base, expectedBranch, manifest, resolvedBase?.commit),
    ...(await commitChecks(git, base, manifest, named?.commit))
  ]
  return {
    repo: manifest.repo,
    base: resolvedBase?.commit ?? manifest.base,
    branch: manifest.branch,
    commit: named?.commit ?? manifest.commit,
    passed: checks.every((item) => item.status === 'passed'),
    checks
  }
}

/**
 * Verifies a learning card's manifests against the bases its link recorded, one repository at a time: exactly one
 * manifest per base, naming that base, the card's isolated branch and a commit that exists, descends from the base
 * and is the branch's tip. Never throws for something Git does not know: that is a failed check with a reason.
 */
export async function verifyLearningManifests(
  gitFor: (repo: string | null) => GitAdapter,
  input: { cardKey: string; bases: LearningIncrementBase[]; manifests: LearningBranchManifest[] }
): Promise<LearningManifestProof> {
  const reasons: string[] = []
  const verified: VerifiedLearningManifest[] = []
  const adapters: GitAdapter[] = []
  for (const manifest of input.manifests) {
    if (!input.bases.some((base) => base.repo === manifest.repo)) {
      reasons.push(`The manifest for ${label(manifest.repo)} names no affected repository of this card.`)
    }
  }
  for (const base of input.bases) {
    const named = input.manifests.filter((manifest) => manifest.repo === base.repo)
    if (named.length !== 1) {
      reasons.push(
        named.length === 0
          ? `No manifest covers ${label(base.repo)} (increment ${short(base.commit)}).`
          : `${named.length} manifests name ${label(base.repo)}; give exactly one.`
      )
      continue
    }
    const git = gitFor(base.repo)
    adapters.push(git)
    const result = await verifyOne(git, base, learningBranchName(input.cardKey, base.repo), named[0] as LearningBranchManifest)
    verified.push(result)
    for (const failed of result.checks.filter((item) => item.status === 'failed')) reasons.push(failed.detail)
  }
  return {
    passed: reasons.length === 0,
    reasons,
    manifests: verified,
    manifestsHash: contentHash(input.manifests),
    assertCurrent: () => {
      for (const git of adapters) git.assertCurrent?.()
    }
  }
}
