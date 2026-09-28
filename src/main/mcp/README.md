# MCP layer starting point

`@modelcontextprotocol/sdk` and `zod` are installed. Their source, declarations, and package READMEs are available under `node_modules` offline.

Start with a stdio server exposing `list_tickets`, `get_ticket`, and `update_ticket_status`. Keep ticket operations in a shared main-process service so the desktop IPC handlers and MCP tools use the same validation and persistence. A stdio server should have its own Node entry point and build command; this directory is currently only a placeholder, not a running server.

Keep credentials, filesystem access, and MCP transports out of the renderer. Send diagnostics to stderr when using stdio. Decide how the separate MCP process and desktop app share storage before implementing writes.
