/**
 * The agent browser's origin policy: which pages it may open and which requests a page may make. Kept free of
 * Electron imports (like `src/main/desktop/navigation.ts`) so every rule is unit and mutation tested; the browser
 * session only feeds it URLs.
 *
 * Fail closed throughout. A URL is parsed with WHATWG `URL` and compared by its serialized origin, never by text
 * prefix, so `http://localhost:5173` and `http://localhost:5174` are different sites and `localhost.evil.example` is
 * not localhost. Parsing also canonicalizes alternate host forms (IDN to punycode, `127.1` and `0x7f000001` to
 * `127.0.0.1`, IPv6 compression) before any address rule looks at them.
 *
 * These rules see only the literal host. A DNS name that resolves into a refused class passes here; the browser
 * session resolves names and checks the connected address (`classifyHost` on each) to close that gap.
 */
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'
import { isAppUrl } from '../desktop/navigation'

/** Why a target was refused. `secret_refused` matches the browser control error of the same name. */
type TargetRefusal = 'invalid_url' | 'scheme' | 'userinfo' | 'blocked_host' | 'secret_refused' | 'app_page'

/** A page the browser may be asked to open: `origin` is null only for `about:blank`, which belongs to no site. */
interface BrowserTarget {
  origin: string | null
  href: string
}

export type NormalizedTarget = BrowserTarget | { refused: TargetRefusal }

/**
 * What a host is, by its literal address or name:
 * - `blocked`: link-local, unspecified and cloud metadata addresses, never reachable;
 * - `loopback` and `private` (RFC 1918, fc00::/7): reachable as subresources only from a loopback or private page;
 * - `public`: everything else.
 */
export type HostClass = 'blocked' | 'loopback' | 'private' | 'public'

const PAGE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])
const NETWORK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])
/** In-page payloads that open no connection of their own. */
const INLINE_PROTOCOLS: ReadonlySet<string> = new Set(['data:', 'blob:'])

const BLOCKED_NAMES: ReadonlySet<string> = new Set(['metadata.google.internal'])

/** An IPv4 range as its first address and prefix length. */
type Range4 = readonly [first: string, bits: number]

const IPV4_RANGES: readonly (readonly [HostClass, readonly Range4[]])[] = [
  ['blocked', [['0.0.0.0', 8], ['169.254.0.0', 16], ['100.100.100.200', 32]]],
  ['loopback', [['127.0.0.0', 8]]],
  ['private', [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]]]
]

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4Value(text: string): number | null {
  const parts = IPV4.exec(text)?.slice(1).map(Number)
  if (parts === undefined || parts.some((part) => part > 255)) return null
  return parts.reduce((value, part) => value * 256 + part, 0)
}

function inRange4(value: number, [first, bits]: Range4): boolean {
  const size = 2 ** (32 - bits)
  return Math.floor(value / size) === Math.floor((ipv4Value(first) ?? 0) / size)
}

function classifyIpv4(value: number): HostClass {
  return IPV4_RANGES.find(([, ranges]) => ranges.some((range) => inRange4(value, range)))?.[0] ?? 'public'
}

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 part allowed), or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split('::')
  if (halves.length > 2) return null
  const words = halves.map((half) => (half === '' ? [] : half.split(':')))
  const tail = words.at(-1)?.at(-1)
  const embedded = tail === undefined ? null : ipv4Value(tail)
  if (embedded !== null) words.at(-1)?.splice(-1, 1, (embedded >>> 16).toString(16), (embedded & 0xffff).toString(16))
  const count = words.flat().length
  if (halves.length === 1 ? count !== 8 : count > 7) return null
  const groups = [...words[0], ...Array<string>(8 - count).fill('0'), ...(words[1] ?? [])]
  return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? groups.map((group) => parseInt(group, 16)) : null
}

const isZero = (groups: readonly number[]): boolean => groups.every((group) => group === 0)

/**
 * The IPv4 address an IPv6 address carries in its last 32 bits: IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible
 * (`::/96`) or NAT64 (`64:ff9b::/96`). Null for any other address.
 */
function embeddedIpv4(groups: readonly number[]): number | null {
  const head = groups.slice(0, 6)
  const carries =
    isZero(head) || (isZero(head.slice(0, 5)) && head[5] === 0xffff) || (head[0] === 0x64 && head[1] === 0xff9b && isZero(head.slice(2)))
  return carries ? groups[6] * 0x10000 + groups[7] : null
}

const EC2_METADATA_V6 = [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]

function classifyIpv6(groups: readonly number[]): HostClass {
  if (isZero(groups)) return 'blocked'
  if (isZero(groups.slice(0, 7)) && groups[7] === 1) return 'loopback'
  if ((groups[0] & 0xffc0) === 0xfe80 || groups.every((group, index) => group === EC2_METADATA_V6[index])) return 'blocked'
  const embedded = embeddedIpv4(groups)
  if (embedded !== null) return classifyIpv4(embedded)
  return (groups[0] & 0xfe00) === 0xfc00 ? 'private' : 'public'
}

function classifyName(name: string): HostClass {
  if (BLOCKED_NAMES.has(name)) return 'blocked'
  // Chromium answers every `*.localhost` name with loopback itself, without asking DNS.
  return name === 'localhost' || name.endsWith('.localhost') ? 'loopback' : 'public'
}

/**
 * The class of a host: a URL's `hostname` (IPv6 in brackets) or a bare address such as `dns.lookup` returns.
 * Case and trailing dots are ignored, so `LOCALHOST.` is loopback.
 */
export function classifyHost(host: string): HostClass {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.+$/, '')
  const v4 = ipv4Value(bare)
  if (v4 !== null) return classifyIpv4(v4)
  const v6 = bare.includes(':') ? ipv6Groups(bare) : null
  if (v6 !== null) return classifyIpv6(v6)
  return bare.includes(':') ? 'blocked' : classifyName(bare)
}

const isLocal = (hostClass: HostClass): boolean => hostClass === 'loopback' || hostClass === 'private'

function decodedOrSame(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Whether the text, as given or percent-decoded, carries a grant token or a claim token. */
function holdsSecret(text: string): boolean {
  return [text, decodedOrSame(text)].some((form) => maskAgentChatSecretsDeep(form) !== form)
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function refusalOf(parsed: URL, url: string, appUrl: string | null): TargetRefusal | null {
  if (holdsSecret(url) || holdsSecret(parsed.href)) return 'secret_refused'
  if (!PAGE_PROTOCOLS.has(parsed.protocol)) return 'scheme'
  if (parsed.username !== '' || parsed.password !== '') return 'userinfo'
  if (classifyHost(parsed.hostname) === 'blocked') return 'blocked_host'
  return isAppUrl(parsed.href, appUrl) ? 'app_page' : null
}

/**
 * The page a URL opens, or why it is refused. Only http and https pages without userinfo, on a host that is not
 * link-local or cloud metadata, and carrying no secret, are targets; `about:blank` is one that belongs to no site.
 * `appUrl` is the app's own page (dev server or packaged file), which the browser never opens.
 */
export function normalizeTarget(url: string, appUrl: string | null = null): NormalizedTarget {
  const parsed = parse(url)
  if (parsed === null) return { refused: 'invalid_url' }
  if (parsed.href === 'about:blank') return { origin: null, href: parsed.href }
  const refused = refusalOf(parsed, url, appUrl)
  return refused === null ? { origin: parsed.origin, href: parsed.href } : { refused }
}

/** The sites a tab may open without asking: the folder's "Always allow" list (null when unreadable) and this tab's "Allow once" set. */
export interface AllowedSites {
  always: readonly string[] | null
  once: ReadonlySet<string>
}

type NavigationDecision = 'allow' | 'ask' | 'deny'

/**
 * Whether a tab may open a normalized target: `allow` only for an origin on the folder's always list or in the tab's
 * once set (and for `about:blank`), `ask` for any other origin, including when the list is empty or unreadable, and
 * `deny` for a refused target.
 */
export function decideNavigation(target: NormalizedTarget, sites: AllowedSites): NavigationDecision {
  if ('refused' in target) return 'deny'
  if (target.origin === null) return 'allow'
  return sites.always?.includes(target.origin) === true || sites.once.has(target.origin) ? 'allow' : 'ask'
}

/** Whether the page's own origin is on a loopback or private host. */
function isLocalPage(pageOrigin: string | null): boolean {
  const page = pageOrigin === null ? null : parse(pageOrigin)
  return page !== null && PAGE_PROTOCOLS.has(page.protocol) && isLocal(classifyHost(page.hostname))
}

type SubresourceDecision = 'allow' | 'deny'

/** Whether a request opens a connection a page may try at all: http, https, ws or wss, without userinfo or a secret. */
function isAcceptableRequest(url: string, parsed: URL): boolean {
  const plain = parsed.username === '' && parsed.password === ''
  return NETWORK_PROTOCOLS.has(parsed.protocol) && plain && !holdsSecret(url) && !holdsSecret(parsed.href)
}

/**
 * Whether a page may load a subresource. http, https, ws and wss requests are allowed except to link-local and
 * metadata hosts, with userinfo, or carrying a secret; loopback and private hosts only from a page whose own origin
 * is loopback or private, so a remote page cannot reach local dev servers. data and blob are allowed; any other
 * scheme is denied.
 */
export function decideSubresource(url: string, pageOrigin: string | null): SubresourceDecision {
  const parsed = parse(url)
  if (parsed === null) return 'deny'
  if (INLINE_PROTOCOLS.has(parsed.protocol)) return 'allow'
  if (!isAcceptableRequest(url, parsed)) return 'deny'
  const hostClass = classifyHost(parsed.hostname)
  if (hostClass === 'blocked') return 'deny'
  return !isLocal(hostClass) || isLocalPage(pageOrigin) ? 'allow' : 'deny'
}
