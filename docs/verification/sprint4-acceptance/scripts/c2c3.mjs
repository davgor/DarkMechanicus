// c2: getWorkingDiff for 'l/etc/hosts' in a repository holding `l -> /` is refused (invalid_input), no file content.
// c3: in a stash restore conflict, 'Use mine (stashed changes)' leaves the stashed content in the file.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { S, git, start, openRepo, shot, uptime } from './lib.mjs'

const L = join(S, 'scratch-symlink')
const T = join(S, 'scratch-stash')
console.log(uptime())
console.log('c2 $ git ls-files -s l:', git(L, 'ls-files', '-s', 'l'), '| $ git cat-file -p HEAD:l:', git(L, 'cat-file', '-p', 'HEAD:l'), '|', readFileSync('/etc/hosts', 'utf8').split('\n').length, 'lines in /etc/hosts')
console.log('c3 before: $ git status --short:', JSON.stringify(git(T, 'status', '--short')), '| $ git stash list:', JSON.stringify(git(T, 'stash', 'list')))
console.log('c3 before: $ cat s.txt\n' + readFileSync(join(T, 's.txt'), 'utf8'))
const { page, close } = await start([L, T])
try {
  await openRepo(page, 'scratch-symlink')
  for (const kind of ['untracked', 'modified']) {
    const answer = await page.evaluate(
      ([folder, kindArg]) => window.git.getWorkingDiff(folder, { path: 'l/etc/hosts', oldPath: null, kind: kindArg }),
      [L, kind]
    )
    const text = JSON.stringify(answer)
    console.log(`c2 window.git.getWorkingDiff(folder, {path:'l/etc/hosts', oldPath:null, kind:'${kind}'}) ->`, text)
    console.log(`c2 (${kind}) mentions localhost/broadcasthost (hosts content):`, /localhost|broadcasthost/.test(text))
  }

  await openRepo(page, 'scratch-stash')
  const list = page.getByRole('list', { name: 'Conflicted files' })
  await list.waitFor({ timeout: 20000 })
  const row = list.locator('li').filter({ hasText: 's.txt' })
  console.log('c3 conflict row buttons:', JSON.stringify(await row.getByRole('button').allInnerTexts()))
  await shot(page, 'c3-stash-restore-conflict')
  await row.getByRole('button', { name: /^Use mine/ }).click()
  await page.getByText(/0 conflicted files/).or(list.locator('li').filter({ hasText: /resolved/i })).first().waitFor({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await shot(page, 'c3-after-use-mine')
  console.log('c3 after Use mine: $ cat s.txt\n' + readFileSync(join(T, 's.txt'), 'utf8'))
  console.log('c3 after: $ git status --short:', JSON.stringify(git(T, 'status', '--short')), '| $ git diff HEAD -- s.txt:\n' + git(T, 'diff', 'HEAD', '--', 's.txt'))
} catch (error) {
  await shot(page, 'c2c3-error')
  throw error
} finally {
  await close()
}
console.log(uptime())
