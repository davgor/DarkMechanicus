interface ForgeProject {
  folder: string
  repository: string
}

export interface ForgeWorld {
  version: 1
  owner: string
  projects: ForgeProject[]
  syncMinutes: number
}

export interface ForgeApi {
  connect(folder: string, repository: string, publish: boolean): Promise<string>
  restore(member: string, mode: 'db' | 'repo'): Promise<string | null>
  pickConvert(world: string): Promise<void>
  convert(world: string, source: string): Promise<void>
  status(folder: string): Promise<{ last: number | null; error: string | null }>
  sync(folder: string): Promise<void>
  create(folder: string): Promise<void>
  add(folder: string, repository: string, name: string): Promise<void>
  interval(folder: string, minutes: number): Promise<void>
}
