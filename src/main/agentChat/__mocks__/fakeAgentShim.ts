import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The fixture is Node input, never an executable whose git mode matters. */
export function fakeAgentShim(directory: string, fixture: string, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(directory, { recursive: true })
  if (platform === 'win32') {
    const executable = join(directory, 'fake-claude.cmd')
    writeFileSync(executable, '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-claude.js" %*\r\n')
    writeFileSync(join(directory, 'fake-claude.js'), `import(require('node:url').pathToFileURL(${JSON.stringify(fixture)}).href)\n`)
    return executable
  }
  const executable = join(directory, 'fake-claude')
  const quoted = `'${fixture.replaceAll("'", "'\\''")}'`
  writeFileSync(executable, `#!/bin/sh\nexec node ${quoted} "$@"\n`)
  chmodSync(executable, 0o755)
  return executable
}
