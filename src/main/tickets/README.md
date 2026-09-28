# Ticket service starting point

Implement ticket persistence and operations here. Begin with a small local JSON store or evaluate SQLite once the data model is settled; no database binary or service is required by the current shell.

Suggested first fields: stable ID, title, description, status, acceptance criteria, dependency IDs, and timestamps. Put renderer-safe types and validation in `src/shared`; expose narrow typed IPC methods through `src/preload/index.ts`. The MCP layer should reuse these operations.

The markdown development board under `/board` remains separate from the future application's ticket storage. Nothing reads or modifies board tickets automatically.
