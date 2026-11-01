/**
 * A scripted `HttpFetch` for GitHub tests. Not shipped. Each call takes the next answer from the
 * queue: a JSON response, a thrown error (a network failure), or a function of the request. Every
 * request is recorded with its decoded form body.
 */
import type { HttpFetch, HttpRequest, HttpResponse } from '../main/github/http'

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  form: Record<string, string>
  redirect?: HttpRequest['redirect']
}

type Answer = HttpResponse | Error | ((request: HttpRequest) => HttpResponse | Promise<HttpResponse>)

export interface FakeHttp {
  fetch: HttpFetch
  readonly requests: RecordedRequest[]
  /** Queues answers, served in order. */
  answer(...answers: Answer[]): void
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const lower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    json: async () => body
  }
}

export function createFakeHttp(): FakeHttp {
  const queue: Answer[] = []
  const requests: RecordedRequest[] = []
  return {
    requests,
    answer: (...answers) => {
      queue.push(...answers)
    },
    fetch: async (url, request) => {
      const form = Object.fromEntries(new URLSearchParams(request.body ?? ''))
      requests.push({ url, method: request.method, headers: { ...request.headers }, form, ...(request.redirect === undefined ? {} : { redirect: request.redirect }) })
      const next = queue.shift()
      if (next === undefined) {
        throw new Error(`No answer queued for ${url}`)
      }
      if (next instanceof Error) {
        throw next
      }
      return typeof next === 'function' ? next(request) : next
    }
  }
}
