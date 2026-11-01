/**
 * Titles of tickets that target one repository of a folder of repositories. Such a title is the repository's
 * prefix followed by the ticket's description (`alpha - Add refund endpoint`); the server keeps the prefix in
 * step with the ticket's `repo`, so a planner only ever supplies the description.
 */

/** The prefix a ticket targeting `repo` carries in its title. */
export function repoPrefix(repo: string): string {
  return `${repo} - `
}

/** The title of a ticket targeting `repo` whose description is `description`. */
export function withRepoPrefix(repo: string, description: string): string {
  return `${repoPrefix(repo)}${description}`
}

/** The description in `title`: the title without `repo`'s exact prefix, or the whole title when it lacks it. */
export function descriptionOf(repo: string | undefined, title: string): string {
  if (repo === undefined) {
    return title
  }
  const prefix = repoPrefix(repo)
  return title.startsWith(prefix) ? title.slice(prefix.length) : title
}
