# 0006 — Image attachments

- **Status:** accepted
- **Date:** 2026-11-06

## Context

Agents work in terminals and hand a person text. A screenshot of the result, or a mockup a worker must match, had no
place in a plan, a Kanban card, a comment or an attempt's evidence, so a person had to take an agent's word for what a
screen looked like. Images had to travel with the records they belong to, through Git and between machines, without
giving an agent a way to read arbitrary files or to fill the repository with large binaries.

## Decision

- **An image is a stored record with an owner.** The `attachments` table (id prefix `im`; `at` belongs to attempts)
  keeps the bytes, mime type, size, SHA-256, label, purpose and who staged it. Owners are an attempt, a Kanban
  attempt, a comment, a Kanban card and a plan ticket. A staged image has no owner until a record names its id and
  claims it; staged images that are never claimed are pruned. Purpose is `evidence` (what an attempt proves) or
  `reference` (what a person or planner shows an agent); a card or ticket accepts references only.
- **Two ways in.** An agent calls `add_attachment { path, label, purpose }` with a file on its own machine; the app
  calls `uploadAttachment` with base64 bytes from a paste, drop or file picker. Each is refused on the other's
  transport, so an agent cannot upload arbitrary bytes and the app cannot name a path. `get_attachment
  { attachmentId, as: metadata | file }` reads one: `file` writes a copy to a temp file and returns its `path`.
- **Where an image attaches.** `submit_attempt` and `submit_kanban_card` take `evidence.attachments`; `add_comment`
  takes `attachments`; `create_kanban_card` and `update_kanban_card` take `attachments` (an update replaces the
  list); plan tickets take them in `update_plan_draft`, `create_ticket` and `update_ticket`, and the draft's images are
  claimed when the plan is saved. Execution and card packets list the references.
- **A ticket keeps the images it showed.** An image a later revision drops stays owned by its ticket: earlier saved
  revisions, their content hashes, repo-mode snapshots and imports still name it, and an import re-owns every image
  any saved revision names on a ticket, so releasing it would make machines disagree. It is never pruned, may be shown
  on the same ticket again, and is refused on any other ticket or record.
- **Allowed folders.** `add_attachment` reads only from the project and its Git worktrees, the system temp folder and
  the operating system's screenshot folder (`Pictures/Screenshots` on Windows and Linux, the `screencapture`
  location or Desktop on macOS). Paths are resolved through links first, so a link out of those folders is refused.
- **Limits.** PNG or JPEG only, judged by the bytes, not the extension; at most 10 MiB, 8000 pixels per side and 20
  images per record. A file that is not an image, or is truncated or oversized, is refused before anything is stored.
- **Storage per mode.** SQLite holds the bytes in both modes, and is what the app reads. In `db` mode that is all. In
  `repo` mode the finalizer also exports each image into its owner's folder: `history/<runId>/attachments/`,
  `kanban/<cardId>/attachments/` and `epics/<epicId>/attachments/`, named `<sha256>.<ext>`, with an
  `<attachmentId>.json` sidecar recording who staged it. The image is written before the record that references it.
  Records omit `attachments` when empty, so existing records and plan hashes do not change, and there is no schema
  migration for refs: they are read from the table.
- **Import is strict.** Every file is untrusted: size, type, dimensions, SHA-256 against the record, and the sidecar
  against its file name are checked, and a bad or absent file leaves a `missing` reference instead of failing the
  import.
- **Protocol.** The renderer loads images through a privileged `dm-attachment:` scheme that serves bytes from SQLite
  for a known workspace and attachment id. It never reads a path from the page, and no other origin can use it.
- **Out of scope: Linear.** A transfer to Linear does not carry images: they stay in Dark Mechanicus, and the guides
  do not promise otherwise.

## Consequences

- A reviewer or person can look at what an agent saw. A criterion that asks for a screenshot can be checked by
  opening the image instead of trusting a sentence.
- Repositories grow by the images they keep; the 10 MiB and 20 per record limits bound each record, not the total.
- The skills version is 1.8.0: the role guides and the CLI instructions now describe attaching and reading images.
