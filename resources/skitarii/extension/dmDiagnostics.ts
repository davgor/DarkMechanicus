// Private child-process IPC progress message. The CLI only emits it while SQLite reports a competing writer.
export const DM_WRITER_BUSY = 'dm.sqlite.writer-busy'

/** The only child stderr line a successful ordinary native command interprets. */
export const SESSION_AUDIT_BUSY = 'session_audit_busy'
export const SESSION_AUDIT_BUSY_MESSAGE = 'The project database was busy while closing the session audit.'
export const SESSION_AUDIT_BUSY_STDERR = `dm: [${SESSION_AUDIT_BUSY}] ${SESSION_AUDIT_BUSY_MESSAGE}`
