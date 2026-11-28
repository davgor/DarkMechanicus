import { describe, expect, it } from 'vitest'
import { classifyHost, decideNavigation, decideSubresource, normalizeTarget, type AllowedSites, type HostClass } from './originPolicy'

const GRANT = `dmg_${'0123456789abcdef'.repeat(2)}`
const CLAIM = `at_0123456789abcdefghjkmnpqrs.${'S'.repeat(32)}`
const CARD_CLAIM = `ka_0123456789abcdefghjkmnpqrs.${'s'.repeat(20)}`

describe('normalizeTarget', () => {
  it.each([
    ['https://example.com/a?b=1#c', 'https://example.com', 'https://example.com/a?b=1#c'],
    ['http://Example.COM:80/', 'http://example.com', 'http://example.com/'],
    ['https://example.com:443', 'https://example.com', 'https://example.com/'],
    ['http://localhost:5173/app', 'http://localhost:5173', 'http://localhost:5173/app'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['http://[::1]:3000', 'http://[::1]:3000', 'http://[::1]:3000/'],
    ['https://bücher.example/', 'https://xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
    ['https://xn--bcher-kva.example/', 'https://xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
    ['http://ｌｏｃａｌｈｏｓｔ:1', 'http://localhost:1', 'http://localhost:1/'],
    ['  https://example.com/\n', 'https://example.com', 'https://example.com/'],
    ['http://10.0.0.5', 'http://10.0.0.5', 'http://10.0.0.5/'],
    ['http://169.255.0.1', 'http://169.255.0.1', 'http://169.255.0.1/'],
    ['https://example.com/?q=%E0%A4%A', 'https://example.com', 'https://example.com/?q=%E0%A4%A'],
    ['https://metadata.google.internal.example', 'https://metadata.google.internal.example', 'https://metadata.google.internal.example/']
  ])('accepts %s as origin %s', (url, origin, href) => {
    expect(normalizeTarget(url)).toEqual({ origin, href })
  })

  it('accepts about:blank as a page of no site', () => {
    expect(normalizeTarget('about:blank')).toEqual({ origin: null, href: 'about:blank' })
    expect(normalizeTarget('about:blank#x')).toEqual({ refused: 'scheme' })
    expect(normalizeTarget('about:srcdoc')).toEqual({ refused: 'scheme' })
  })
})

describe('normalizeTarget refusals of scheme, form and userinfo', () => {
  it.each([
    'file:///C:/Users/dev/secret.txt',
    'file://server/share/x',
    'data:text/html,<p>hi</p>',
    'javascript:alert(1)',
    'blob:https://example.com/4f1c',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'dm-attachment://abc/1.png',
    'dm-chat-image://abc/ci_1',
    'ftp://example.com/',
    'ws://example.com/',
    'wss://example.com/',
    'view-source:https://example.com/',
    'mailto:a@example.com'
  ])('refuses the scheme of %s', (url) => {
    expect(normalizeTarget(url)).toEqual({ refused: 'scheme' })
  })

  it.each(['', 'not a url', '/relative/path', 'http://', 'https://exa mple.com', 'http://[::1'])('refuses %j as invalid', (url) => {
    expect(normalizeTarget(url)).toEqual({ refused: 'invalid_url' })
  })

  it.each(['https://user:pass@example.com/', 'https://user@example.com/', 'https://:pass@example.com/', 'http://a%40b@localhost:5173/'])(
    'refuses userinfo in %s',
    (url) => {
      expect(normalizeTarget(url)).toEqual({ refused: 'userinfo' })
    }
  )
})

describe('normalizeTarget refusals of hosts', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.0.1',
    'http://169.254.255.255:8080',
    'http://0xa9fea9fe/',
    'http://2852039166/',
    'http://169.254.43518/',
    'http://0.0.0.0:5173',
    'http://0/',
    'http://0.1.2.3/',
    'http://100.100.100.200/',
    'http://168.63.129.16/machine?comp=goalstate',
    'http://[::ffff:0:a9fe:a9fe]/',
    'http://[2002:a9fe:a9fe::]/',
    'http://[::]/',
    'http://[::]:5173/',
    'http://[fe80::1]/',
    'http://[febf:ffff::1]/',
    'http://[FE80::ABCD]/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::169.254.169.254]/',
    'http://[::ffff:0.0.0.0]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[::ffff:100.100.100.200]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://METADATA.google.internal./',
    'https://metadata.google.internal:443/'
  ])('refuses the link-local or metadata host of %s', (url) => {
    expect(normalizeTarget(url)).toEqual({ refused: 'blocked_host' })
  })
})

describe('normalizeTarget refusals of secrets and the app page, and stability', () => {
  it.each([
    `https://example.com/?token=${GRANT}`,
    `https://example.com/${CLAIM}`,
    `https://example.com/#${CARD_CLAIM}`,
    `https://example.com/?t=${encodeURIComponent(CLAIM)}`,
    `https://example.com/?t=%64mg_${'ab'.repeat(8)}`,
    `https://${GRANT}.example.com/`,
    `https://user:${GRANT}@example.com/`,
    `file:///${GRANT}`
  ])('refuses the secret in %s', (url) => {
    expect(normalizeTarget(url)).toEqual({ refused: 'secret_refused' })
  })

  it('keeps short look-alikes of secrets, which are not secrets', () => {
    expect(normalizeTarget('https://example.com/?q=dmg_1234&a=at_')).toEqual({
      origin: 'https://example.com',
      href: 'https://example.com/?q=dmg_1234&a=at_'
    })
  })

  it("refuses the app's own page, compared by parsed origin or file path", () => {
    expect(normalizeTarget('http://localhost:5173/#/board', 'http://localhost:5173')).toEqual({ refused: 'app_page' })
    expect(normalizeTarget('file:///C:/app/index.html', 'file:///C:/app/index.html')).toEqual({ refused: 'scheme' })
    expect(normalizeTarget('http://localhost:5174/', 'http://localhost:5173')).toEqual({ origin: 'http://localhost:5174', href: 'http://localhost:5174/' })
    expect(normalizeTarget('http://localhost:5173.evil.example/', 'http://localhost:5173')).toEqual({ refused: 'invalid_url' })
    expect(normalizeTarget('http://localhost.evil.example:5173/', 'http://localhost:5173')).toEqual({
      origin: 'http://localhost.evil.example:5173',
      href: 'http://localhost.evil.example:5173/'
    })
  })

  it('normalizes to a stable origin: normalizing the origin again gives the same origin', () => {
    for (const url of ['https://BÜCHER.example:443/x', 'http://127.1:80/', 'http://[0:0:0:0:0:0:0:1]:9/', 'HTTPS://Example.com.']) {
      const first = normalizeTarget(url)
      if (!('origin' in first) || first.origin === null) throw new Error(`expected ${url} to be a target`)
      expect(normalizeTarget(first.origin)).toMatchObject({ origin: first.origin })
    }
    expect(normalizeTarget('http://127.1/')).toMatchObject({ origin: 'http://127.0.0.1' })
    expect(normalizeTarget('http://[0:0:0:0:0:0:0:1]/')).toMatchObject({ origin: 'http://[::1]' })
  })
})

const HOST_CLASSES: readonly (readonly [string, HostClass])[] = [
  ['localhost', 'loopback'],
  ['LocalHost.', 'loopback'],
  ['app.localhost', 'loopback'],
  ['localhost.evil.example', 'public'],
  ['evillocalhost', 'public'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['128.0.0.1', 'public'],
  ['126.255.255.255', 'public'],
  ['[::1]', 'loopback'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['[::ffff:7f00:1]', 'loopback'],
  ['10.0.0.1', 'private'],
  ['10.255.255.255', 'private'],
  ['11.0.0.0', 'public'],
  ['9.255.255.255', 'public'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private'],
  ['172.15.255.255', 'public'],
  ['172.32.0.0', 'public'],
  ['192.168.1.1', 'private'],
  ['192.169.0.1', 'public'],
  ['192.167.255.255', 'public'],
  ['::ffff:192.168.0.1', 'private'],
  ['::ffff:c0a8:1', 'private'],
  ['fc00::1', 'private'],
  ['[fd12:3456::1]', 'private'],
  ['fdff:ffff::1', 'private'],
  ['fbff::1', 'public'],
  ['fe00::1', 'public'],
  ['169.254.169.254', 'blocked'],
  ['169.253.255.255', 'public'],
  ['169.255.0.0', 'public'],
  ['0.0.0.0', 'blocked'],
  ['0.255.255.255', 'blocked'],
  ['1.0.0.0', 'public'],
  ['100.100.100.200', 'blocked'],
  ['100.100.100.199', 'private'],
  ['100.100.100.201', 'private'],
  ['::', 'blocked'],
  ['0:0:0:0:0:0:0:0', 'blocked'],
  ['fe80::1', 'blocked'],
  ['fe80::1%eth0', 'blocked'],
  ['febf::1', 'blocked'],
  ['fec0::1', 'public'],
  ['fd00:ec2::254', 'blocked'],
  ['fd00:ec2::253', 'private'],
  ['::ffff:169.254.169.254', 'blocked'],
  ['::a9fe:a9fe', 'blocked'],
  ['::0.0.0.2', 'blocked'],
  ['64:ff9b::a9fe:a9fe', 'blocked'],
  ['64:ff9b::7f00:1', 'loopback'],
  ['::ffff:8.8.8.8', 'public'],
  ['::ffff:0:8.8.8.8', 'public'],
  ['168.63.129.16', 'blocked'],
  ['168.63.129.15', 'public'],
  ['168.63.129.17', 'public'],
  ['::ffff:168.63.129.16', 'blocked'],
  ['100.64.0.0', 'private'],
  ['100.127.255.255', 'private'],
  ['100.63.255.255', 'public'],
  ['100.128.0.0', 'public'],
  ['::ffff:0:169.254.169.254', 'blocked'],
  ['::ffff:0:a9fe:a9fe', 'blocked'],
  ['::ffff:0:127.0.0.1', 'loopback'],
  ['::ffff:0:10.0.0.1', 'private'],
  ['::fffe:0:a9fe:a9fe', 'public'],
  ['2002:a9fe:a9fe::', 'blocked'],
  ['2002:a9fe:a9fe:1::1', 'blocked'],
  ['2002:7f00:1::1', 'loopback'],
  ['2002:c0a8:101::1', 'private'],
  ['2002:6440::', 'private'],
  ['2002:808:808::', 'public'],
  ['2003:a9fe:a9fe::', 'public'],
  ['2001:4860:4860::8888', 'public'],
  ['1:2:3:4:5:6:7:8', 'public'],
  ['1:2:3:4:5:6:7:8:9', 'blocked'],
  ['1::2::3', 'blocked'],
  ['1:2:3:4:5:6:7::8', 'blocked'],
  ['::ffff:300.1.1.1', 'blocked'],
  ['metadata.google.internal', 'blocked'],
  ['metadata.google.internal.', 'blocked'],
  ['example.com', 'public'],
  ['256.1.1.1', 'public']
]

describe('classifyHost', () => {
  it.each(HOST_CLASSES)('classifies %s as %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected)
  })
})

describe('decideNavigation', () => {
  const sites = (always: readonly string[] | null, once: readonly string[] = []): AllowedSites => ({ always, once: new Set(once) })

  it('allows only origins on the always list or in the once set; asks for every other', () => {
    const target = normalizeTarget('https://example.com/page')
    expect(decideNavigation(target, sites(['https://example.com']))).toBe('allow')
    expect(decideNavigation(target, sites([], ['https://example.com']))).toBe('allow')
    expect(decideNavigation(target, sites(['https://other.example'], ['http://example.com']))).toBe('ask')
    expect(decideNavigation(target, sites(['https://example.com:443', 'https://example.com/', 'example.com', 'https://EXAMPLE.com']))).toBe('ask')
  })

  it('asks, never allows, when the list is empty or unreadable', () => {
    const target = normalizeTarget('https://example.com/')
    expect(decideNavigation(target, sites([]))).toBe('ask')
    expect(decideNavigation(target, sites(null))).toBe('ask')
    expect(decideNavigation(target, sites(null, ['https://example.com']))).toBe('allow')
  })

  it('scopes localhost by port and never by prefix', () => {
    const allowed = sites(['http://localhost:5173'])
    expect(decideNavigation(normalizeTarget('http://localhost:5173/x'), allowed)).toBe('allow')
    expect(decideNavigation(normalizeTarget('http://localhost:5174/'), allowed)).toBe('ask')
    expect(decideNavigation(normalizeTarget('http://localhost/'), allowed)).toBe('ask')
    expect(decideNavigation(normalizeTarget('https://localhost:5173/'), allowed)).toBe('ask')
    expect(decideNavigation(normalizeTarget('http://127.0.0.1:5173/'), allowed)).toBe('ask')
    expect(decideNavigation(normalizeTarget('http://localhost:5173.evil.example/'), allowed)).toBe('deny')
    expect(decideNavigation(normalizeTarget('http://localhost:5173@evil.example/'), allowed)).toBe('deny')
    expect(decideNavigation(normalizeTarget('http://localhost.evil.example:5173/'), allowed)).toBe('ask')
  })

  it('matches an IDN site by its punycode origin', () => {
    expect(decideNavigation(normalizeTarget('https://bücher.example/'), sites(['https://xn--bcher-kva.example']))).toBe('allow')
  })

  it('denies refused targets, even when listed, and allows about:blank', () => {
    const everything = sites(['http://169.254.169.254', 'file://', 'null'], ['http://169.254.169.254'])
    expect(decideNavigation(normalizeTarget('http://169.254.169.254/'), everything)).toBe('deny')
    expect(decideNavigation(normalizeTarget('file:///etc/passwd'), everything)).toBe('deny')
    expect(decideNavigation(normalizeTarget(`https://example.com/?${GRANT}`), sites(['https://example.com']))).toBe('deny')
    expect(decideNavigation(normalizeTarget('about:blank'), sites(null))).toBe('allow')
  })
})

const REMOTE = 'https://example.com'

describe('decideSubresource allows', () => {
  it.each([
    ['https://cdn.example/app.js', REMOTE],
    ['http://cdn.example/app.js', REMOTE],
    ['wss://socket.example/live', REMOTE],
    ['ws://socket.example/live', REMOTE],
    ['data:image/png;base64,AAAA', REMOTE],
    ['blob:https://example.com/4f1c', REMOTE],
    ['blob:null/4f1c', null],
    ['https://cdn.example/app.js', null],
    ['http://localhost:5173/@vite/client', 'http://localhost:5173'],
    ['ws://localhost:5173/', 'http://localhost:5173'],
    ['http://127.0.0.1:9000/api', 'http://localhost:5173'],
    ['http://[::1]:9000/api', 'http://127.0.0.1:3000'],
    ['http://10.0.0.2/api', 'http://localhost:5173'],
    ['http://100.64.1.1/api', 'http://localhost:5173'],
    ['http://192.168.1.10/api', 'http://10.0.0.1:8080'],
    ['http://localhost:9000/', 'http://192.168.1.10'],
    ['http://[fd00::1]/', 'http://app.localhost:3000'],
    ['https://cdn.example/app.js', 'http://localhost:5173']
  ])('allows %s from %s', (url, page) => {
    expect(decideSubresource(url, page)).toBe('allow')
  })
})

describe('decideSubresource denies', () => {
  it.each([
    ['http://localhost:5173/', REMOTE],
    ['ws://localhost:5173/', REMOTE],
    ['http://127.0.0.1/', REMOTE],
    ['http://127.1/', REMOTE],
    ['http://[::1]/', REMOTE],
    ['http://[::ffff:127.0.0.1]/', REMOTE],
    ['http://app.localhost/', REMOTE],
    ['http://10.0.0.1/', REMOTE],
    ['http://100.64.1.1/', REMOTE],
    ['http://[2002:7f00:1::1]/', REMOTE],
    ['http://[::ffff:0:7f00:1]/', REMOTE],
    ['http://172.16.0.1/', REMOTE],
    ['http://192.168.0.1/', REMOTE],
    ['http://[fd12::1]/', REMOTE],
    ['http://localhost/', null],
    ['http://localhost/', 'not an origin'],
    ['http://localhost/', 'file:///C:/page.html'],
    ['http://localhost/', 'http://localhost.evil.example'],
    ['http://169.254.169.254/latest/', 'http://localhost:5173'],
    ['http://[fe80::1]/', 'http://localhost:5173'],
    ['http://metadata.google.internal/', REMOTE],
    ['http://100.100.100.200/', 'http://10.0.0.1'],
    ['http://168.63.129.16/', 'http://10.0.0.1'],
    ['http://[fd00:ec2::254]/', 'http://localhost'],
    ['http://0.0.0.0:5173/', 'http://localhost:5173'],
    ['ftp://example.com/', REMOTE],
    ['file:///etc/passwd', REMOTE],
    ['javascript:alert(1)', REMOTE],
    ['chrome://settings', REMOTE],
    ['dm-chat-image://abc/ci_1', REMOTE],
    ['https://user:pass@cdn.example/', REMOTE],
    [`https://collect.example/?k=${GRANT}`, REMOTE],
    [`wss://collect.example/${CLAIM}`, REMOTE],
    ['not a url', REMOTE]
  ])('denies %s from %s', (url, page) => {
    expect(decideSubresource(url, page)).toBe('deny')
  })
})
