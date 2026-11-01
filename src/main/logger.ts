import { join } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

const USER_DATA_DIR_SWITCH = '--user-data-dir'

function hasUserDataDirSwitch(argv: readonly string[]): boolean {
  return argv.some((arg, index) => {
    if (arg.startsWith(`${USER_DATA_DIR_SWITCH}=`)) {
      return arg.length > USER_DATA_DIR_SWITCH.length + 1
    }
    return arg === USER_DATA_DIR_SWITCH && Boolean(argv[index + 1])
  })
}

/**
 * An instance started with an explicit --user-data-dir keeps its log under
 * <userData>/logs so it never appends to the person's own app log.
 */
export function resolveLogFilePath(input: {
  argv: readonly string[]
  getUserDataPath: () => string
  defaultDir: string
  fileName: string
}): string {
  if (hasUserDataDirSwitch(input.argv)) {
    return join(input.getUserDataPath(), 'logs', input.fileName)
  }
  return join(input.defaultDir, input.fileName)
}

log.initialize()
// Set before any write; electron-log resolves the path lazily on first write.
log.transports.file.resolvePathFn = (variables) =>
  resolveLogFilePath({
    argv: process.argv,
    getUserDataPath: () => app.getPath('userData'),
    defaultDir: variables.libraryDefaultDir,
    fileName: variables.fileName ?? 'main.log'
  })

export const logger = log

export function setupGlobalErrorLogging(): void {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error)
  })

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason)
  })
}
