/**
 * The HTTP surface GitHub calls go through (Electron's `net.fetch` in the app, a script in tests), and
 * the two steps every call shares. A caught fetch error is never passed on: it may hold the request,
 * whose headers carry the token.
 */
import { GithubError } from './errors'

export interface HttpRequest {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** `send` always sets `error`: a redirect must never carry the token elsewhere. */
  redirect?: 'error'
}

export interface HttpResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

export type HttpFetch = (url: string, request: HttpRequest) => Promise<HttpResponse>

/**
 * Sends a request that refuses to follow redirects (one fails like any other network error): an abort
 * ends it with `cancelled`, any other failure to get an answer with `network_unreachable`.
 */
export async function send(fetch: HttpFetch, url: string, request: Omit<HttpRequest, 'redirect'>): Promise<HttpResponse> {
  let response: HttpResponse
  try {
    response = await fetch(url, { ...request, redirect: 'error' })
  } catch {
    throw new GithubError(request.signal?.aborted === true ? 'cancelled' : 'network_unreachable')
  }
  if (request.signal?.aborted === true) {
    throw new GithubError('cancelled')
  }
  return response
}

/** The response body as JSON: an abort while it is read is `cancelled`, a body that is not JSON `github_failed`. */
export async function readJson(response: HttpResponse, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new GithubError(signal?.aborted === true ? 'cancelled' : 'github_failed')
  }
}
