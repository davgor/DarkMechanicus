import type { GithubRepository } from '../../../shared/github/api'

/** A GitHub repository for clone tests; `fullName` and `cloneUrl` follow `owner` and `name`. */
export function repository(patch: Partial<GithubRepository> & Pick<GithubRepository, 'owner' | 'name'>): GithubRepository {
  return {
    fullName: `${patch.owner}/${patch.name}`,
    private: false,
    fork: false,
    description: null,
    cloneUrl: `https://github.com/${patch.owner}/${patch.name}.git`,
    pushedAt: null,
    ...patch
  }
}
