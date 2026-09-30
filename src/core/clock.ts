export interface Clock {
  nowMs(): number
  nowIso(): string
}

export function createSystemClock(): Clock {
  return {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString()
  }
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString()
}

export function isBefore(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b)
}
