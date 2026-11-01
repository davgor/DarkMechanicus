/** What a clone accepts before git runs: the URL's transport and the new folder's name. */
import { describe, expect, it } from 'vitest'
import { checkCloneName, cloneUrl } from './cloneInput'
import { GitInputError } from './errors'

describe('cloneUrl: https, ssh, scp-like and owner/repo', () => {
  it.each([
    ['https://github.com/octocat/Hello-World.git', 'https://github.com/octocat/Hello-World.git'],
    ['https://github.com/octocat/Hello-World', 'https://github.com/octocat/Hello-World'],
    ['  https://gitlab.example.com/group/sub/repo.git  ', 'https://gitlab.example.com/group/sub/repo.git'],
    ['HTTPS://GitHub.com/octocat/Hello-World', 'https://github.com/octocat/Hello-World'],
    ['https://git.example.com:8443/repo.git', 'https://git.example.com:8443/repo.git'],
    ['ssh://git@github.com/octocat/Hello-World.git', 'ssh://git@github.com/octocat/Hello-World.git'],
    ['ssh://git@git.example.com:2222/srv/repo.git', 'ssh://git@git.example.com:2222/srv/repo.git'],
    ['ssh://git@[2001:db8::1]/srv/repo.git', 'ssh://git@[2001:db8::1]/srv/repo.git'],
    ['ssh://work_alias/srv/repo.git', 'ssh://work_alias/srv/repo.git'],
    ['https://user%40example.com@git.example.com/repo.git', 'https://user%40example.com@git.example.com/repo.git'],
    ['git@github.com:octocat/Hello-World.git', 'git@github.com:octocat/Hello-World.git'],
    ['deploy.bot@git.example.com:team/repo.git', 'deploy.bot@git.example.com:team/repo.git'],
    ['octocat/Hello-World', 'https://github.com/octocat/Hello-World.git'],
    ['octocat/Hello-World.git', 'https://github.com/octocat/Hello-World.git'],
    ['octo-cat/.github', 'https://github.com/octo-cat/.github.git'],
    ['a/b_c.d-e', 'https://github.com/a/b_c.d-e.git']
  ])('%j becomes %j', (input, expected) => {
    expect(cloneUrl(input)).toBe(expected)
  })
})

describe('cloneUrl: other transports and local paths are refused', () => {
  it.each([
    'file:///tmp/repo.git',
    'FILE:///tmp/repo.git',
    'file:/tmp/repo.git',
    'ext::sh -c touch% /tmp/pwned',
    'ext::ssh -oProxyCommand=evil host %S',
    'fd::17',
    'testgit::/tmp/repo',
    'git://github.com/octocat/Hello-World.git',
    'http://github.com/octocat/Hello-World.git',
    'git+ssh://git@github.com/octocat/Hello-World.git',
    'ftp://example.com/repo.git',
    'rsync://example.com/repo.git',
    '/tmp/repo.git',
    './repo',
    '../repo',
    '~/repo',
    'C:\\repos\\repo',
    'C:/repos/repo',
    '\\\\server\\share\\repo'
  ])('%j', (input) => {
    expect(() => cloneUrl(input)).toThrow(GitInputError)
  })
})

describe('cloneUrl: options, control characters and option-like hosts are refused', () => {
  it.each([
    '-uhttps://github.com/octocat/Hello-World',
    '--upload-pack=touch /tmp/pwned',
    '  --template=/tmp/evil',
    'https://github.com/octo\0cat/Hello-World',
    'https://github.com/octocat/Hello-World\nprotocol=https',
    'git@github.com:octocat/Hello-World\r',
    'https://github.com/octocat/Hello-World%0ahost=evil.example.com',
    'ssh://git@github.com/octocat/%00repo',
    'ssh://-oProxyCommand=touch%20pwned/repo',
    'ssh://%2DoProxyCommand=touch%20pwned/repo',
    'ssh://-oProxyCommand=x@git.example.com/repo',
    'git@-oProxyCommand=x:repo',
    '-oProxyCommand=x@git.example.com:repo',
    'git@github.com:-oProxyCommand=x',
    'git@ext::sh -c touch',
    'git@github.com::octocat/Hello-World',
    'git@[::1]:repo',
    'ssh://%5B-oProxyCommand=x%5D/repo',
    'ssh://u%40%5B-oX%5D@git.example.com/repo',
    'ssh://%2F-oX/repo',
    'ssh://$(touch${IFS}x)@git.example.com/repo',
    'ssh://git@git%20example.com/repo'
  ])('%j', (input) => {
    expect(() => cloneUrl(input)).toThrow(GitInputError)
  })
})

describe('cloneUrl: incomplete input is refused', () => {
  it.each(['', '   ', 'https://', 'https:///repo', 'https://github.com', 'https://github.com/', 'ssh://', 'git@github.com:', 'octocat', 'octocat/', '/Hello-World', 'a/b/c', '-octo/repo', 'octo/..', 'octo/.', 'octo/.git', 'octo/re po'])(
    '%j',
    (input) => {
      expect(() => cloneUrl(input)).toThrow(GitInputError)
    }
  )
})

describe('cloneUrl: the test-only file allowance', () => {
  it('lets a file:// URL through only when asked, and nothing else it would refuse', () => {
    expect(cloneUrl('file:///tmp/origin.git', { allowFile: true })).toBe('file:///tmp/origin.git')
    for (const input of ['/tmp/origin.git', 'ext::sh -c x', 'http://example.com/repo.git', 'file:///tmp/a\nb']) {
      expect(() => cloneUrl(input, { allowFile: true }), input).toThrow(GitInputError)
    }
  })
})

describe('checkCloneName: accepted', () => {
  it.each(['Hello-World', 'repo.v2', '.github', 'two words', 'ünïcode', 'a'.repeat(255), 'con-fig', 'CONSOLE', 'COM10', 'LPT', 'nul-thing', 'auxiliary.txt'])('%j', (name) => {
    expect(() => {
      checkCloneName(name)
    }).not.toThrow()
  })
})

describe('checkCloneName: refused', () => {
  it.each([
    ['', 'Enter a name'],
    ['.', 'cannot be . or ..'],
    ['..', 'cannot be . or ..'],
    ['a/b', 'cannot contain'],
    ['a\\b', 'cannot contain'],
    ['/abs', 'cannot contain'],
    ['CON', 'reserves'],
    ['con', 'reserves'],
    ['Nul', 'reserves'],
    ['nul.txt', 'reserves'],
    ['CON .txt', 'reserves'],
    ['COM1', 'reserves'],
    ['com9.git', 'reserves'],
    ['LPT3', 'reserves'],
    ['AUX', 'reserves'],
    ['PRN', 'reserves'],
    ['COM\u00b9', 'reserves'],
    ['name.', 'end in a dot or a space'],
    ['name ', 'end in a dot or a space'],
    ['a'.repeat(256), 'longer than 255'],
    ['.git', '.git'],
    ['.GIT', '.git'],
    ['git~1', '.git'],
    ['.g\u200cit', '.git'],
    ['.git\u200c', '.git'],
    ['\ufeff.git', '.git'],
    ['.gi\u200dt', '.git'],
    ['\u200e.GIT', '.git'],
    ['a:b', 'cannot contain'],
    ['a\0b', 'cannot contain'],
    ['tab\there', 'cannot contain'],
    ['x<y', 'cannot contain'],
    ['x|y', 'cannot contain'],
    ['x?y', 'cannot contain'],
    ['x*y', 'cannot contain'],
    ['x"y', 'cannot contain']
  ])('%j', (name, message) => {
    expect(() => {
      checkCloneName(name)
    }).toThrow(GitInputError)
    expect(() => {
      checkCloneName(name)
    }).toThrow(message)
  })
})
