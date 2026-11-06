# Epic outcome: image attachments

Epic `ep_01m6fmd1m24pf5nmyke0w4ag6h`, closed by the sprint 2 acceptance node DM-429. All 7 success criteria are met. Sprint 1 evidence is in
[`../sprint-1/`](../sprint-1/). Sprint 2 evidence is in this folder.

Sprint 2's runtime checks used builds of the `img-s2` worktree only. The built app ran as
`electron.exe --inspect=9545 <worktree> --user-data-dir=<scratch>/ud --remote-debugging-port=9544`, with `DISABLE_AUTO_UPDATE=1` and
`DARKMECHANICUS_HOME=<scratch>/home`, and the CLI ran as `node out/main/cli.js`. Both pointed only at scratch folders under
`%TEMP%\dmplan\accept-s2\`: `repo`, a repo-mode folder, and `dbrepo`, a database-only folder. The app's Agent access grants were issued
over the DevTools protocol, which also stubbed the folder dialog and drove paste, drop and file-picker input with synthetic events that
carried real PNG `File`s.

## s1: an image can be attached from a terminal, as attempt evidence or as a reference on a ticket, card or comment. Met

- Attempt evidence from the CLI:
  - Sprint 1: [`c1-add-attachment-cli.txt`](../sprint-1/c1-add-attachment-cli.txt) and
    [`c3-worker-add-get-attachment.txt`](../sprint-1/c3-worker-add-get-attachment.txt).
  - Sprint 2: [`c13-part1-evidence-submit.txt`](c13-part1-evidence-submit.txt), where a worker grant submits REP-2 with `evidence.attachments`.
  - Sprint 2: [`c14-runbook-powershell.txt`](c14-runbook-powershell.txt), which follows the runbook in PowerShell 5.1.
- A comment reference: [`c4-cli-comment-image.txt`](c4-cli-comment-image.txt) and [`c3-repo-mode.txt`](c3-repo-mode.txt) (an epic comment).
- A Kanban card: [`c5-kanban-card-cli.txt`](c5-kanban-card-cli.txt).
- A plan ticket, through `update_plan_draft`: [`c6-draft-image-claimed-on-save.txt`](c6-draft-image-claimed-on-save.txt).
- `--args-file` in both Windows shells: [`c11-powershell.txt`](c11-powershell.txt) and [`c11-git-bash.txt`](c11-git-bash.txt).

## s2: images are stored with the folder's project data and survive app restarts. Met

- **Repo mode: files next to their records.**
  - Sprint 1: [`c4.txt`](../sprint-1/c4.txt), with run and card folders.
  - Sprint 2, epic folder: [`c3-repo-mode.txt`](c3-repo-mode.txt) shows `epics/<id>/attachments/<sha>.png` plus the `<id>.json` sidecar.
  - Sprint 2, comment: [`c4-cli-comment-image.txt`](c4-cli-comment-image.txt).
  - Sprint 2, card folder: [`c5-kanban-card-cli.txt`](c5-kanban-card-cli.txt).
- **Database-only mode: SQLite blobs, no files.** [`s2-db-mode.txt`](s2-db-mode.txt) shows:
  - nothing but `.git/` and `README.md` in the folder;
  - blob lengths and SHA-256 equal to the originals, before and after an app restart;
  - `get_attachment` returning a readable copy after the restart.

  The card still renders after the restart: [`s2-db-mode-card-image-after-app-restart.png`](s2-db-mode-card-image-after-app-restart.png).
  [`test-excerpts.txt`](test-excerpts.txt) has the db-mode test "completes the entry and writes no file".
- **Surviving a restart, and even a deleted `local/state.sqlite`, in repo mode.**
  - Sprint 1: [`c4-after-state-sqlite-deleted-*.png`](../sprint-1/).
  - Sprint 2, ticket: [`c7-overview-after-state-sqlite-deleted-and-reopened.png`](c7-overview-after-state-sqlite-deleted-and-reopened.png).
  - Sprint 2, comment: [`x1-comment-image-after-state-sqlite-deleted.png`](x1-comment-image-after-state-sqlite-deleted.png).
  - Sprint 2, card: [`x1-card-mockup-after-state-sqlite-deleted.png`](x1-card-mockup-after-state-sqlite-deleted.png).
  - Sprint 2, evidence: [`c13-evidence-tab-after-state-sqlite-deleted.png`](c13-evidence-tab-after-state-sqlite-deleted.png).
  - Sprint 2, original `createdBy` kept: [`c13-createdby-after-state-delete.txt`](c13-createdby-after-state-delete.txt).

## s3: the app renders images inline as thumbnails, with click-to-enlarge, wherever evidence or a reference appears. Met

- **Thumbnails:**
  - Ticket Evidence tab: sprint 1 [`c7-ticket-evidence-tab-thumbnails.png`](../sprint-1/c7-ticket-evidence-tab-thumbnails.png).
  - Kanban card: sprint 1 [`c7-kanban-card-attachments-thumbnails.png`](../sprint-1/c7-kanban-card-attachments-thumbnails.png) and
    sprint 2 [`c5-cli-card-mockup-and-references-panel.png`](c5-cli-card-mockup-and-references-panel.png).
  - Ticket Comments tab: [`c4-cli-comment-image-in-comments-tab.png`](c4-cli-comment-image-in-comments-tab.png) and
    [`c8-pasted-image-rendered-after-post.png`](c8-pasted-image-rendered-after-post.png).
  - Ticket Overview tab: [`c7-overview-image-references-expected-artifacts.png`](c7-overview-image-references-expected-artifacts.png).
- **Click-to-enlarge:**
  - Sprint 1: [`c7-ticket-evidence-lightbox-open.png`](../sprint-1/c7-ticket-evidence-lightbox-open.png) and
    [`c7-kanban-card-lightbox-open.png`](../sprint-1/c7-kanban-card-lightbox-open.png).
  - Sprint 2: [`s3-card-mockup-lightbox.png`](s3-card-mockup-lightbox.png) and
    [`s3-comment-image-lightbox.png`](s3-comment-image-lightbox.png).
  - Comments, Overview, Evidence and the card panel all render the same `AttachmentGallery` component, which owns the lightbox.
- **Loading:** every image loads through `dm-attachment://` in dev and in the built app. See sprint 1 [`c6.txt`](../sprint-1/c6.txt) and
  the `img` sources logged in this round.

## s4: each image is labelled as evidence or as a mockup or reference. Met

- **Data:** `purpose` is `evidence` or `reference` on every `get_attachment` result. Examples: [`c13-createdby-after-state-delete.txt`](c13-createdby-after-state-delete.txt)
  (evidence) and [`c6-draft-image-claimed-on-save.txt`](c6-draft-image-claimed-on-save.txt) (reference).
- **App:** a chip under each thumbnail names the purpose: "Reference" in [`c4-cli-comment-image-in-comments-tab.png`](c4-cli-comment-image-in-comments-tab.png),
  [`c5-cli-card-mockup-and-references-panel.png`](c5-cli-card-mockup-and-references-panel.png) and [`s3-card-mockup-lightbox.png`](s3-card-mockup-lightbox.png),
  and "Evidence" in sprint 1 [`c7-ticket-evidence-tab-thumbnails.png`](../sprint-1/c7-ticket-evidence-tab-thumbnails.png).

## s5: workers can read attached images back, by path or content, to use mockups as references. Met

- **`get_attachment` with `"as":"file"`** returns a local path whose bytes hash to the stored SHA-256:
  - sprint 1 [`c3-worker-add-get-attachment.txt`](../sprint-1/c3-worker-add-get-attachment.txt);
  - sprint 2 [`x3-get-attachment-file.txt`](x3-get-attachment-file.txt), a plan ticket's mockup in repo mode;
  - [`s2-db-mode.txt`](s2-db-mode.txt), a card image in database-only mode.
- **Packets carry the refs:**
  - the execution packet of a claimed ticket: [`c6-draft-image-claimed-on-save.txt`](c6-draft-image-claimed-on-save.txt);
  - Kanban card packets: [`test-excerpts.txt`](test-excerpts.txt), section c5.

## s6: oversized, unsupported or out-of-folder files are rejected with a clear error. Met

- **Runtime CLI refusals,** in [`s6-refusals.txt`](s6-refusals.txt):
  - an 11 MiB file ("exceeds the 10485760 byte (10 MiB) limit");
  - an 8001 px wide PNG ("exceeds 8000 px on a side");
  - a text file named `.png` ("only PNG and JPEG are accepted");
  - a file outside the allowed folders.
- **Sprint 1, in [`c1-add-attachment-cli.txt`](../sprint-1/c1-add-attachment-cli.txt):** a missing file, an out-of-folder file, a
  junction (symbolic link) and a non-image.
- **Tests:** the intake test list is in [`test-excerpts.txt`](test-excerpts.txt), section s6.
- **Bad JSON:** an undoubled backslash in the JSON is refused with a message that says how to fix it:
  [`c11-git-bash.txt`](c11-git-bash.txt), step 1.

## s7: people can add images in the app by pasting, dropping or picking a file. Met

| Input | Where | Before saving | After saving |
| --- | --- | --- | --- |
| Paste: a synthetic `ClipboardEvent` carrying a real PNG `File` | Comment composer | [`c8-paste-pending-preview-before-post.png`](c8-paste-pending-preview-before-post.png) | [`c8-pasted-image-rendered-after-post.png`](c8-pasted-image-rendered-after-post.png) |
| Drop: a synthetic `DragEvent` | Kanban card form | [`c9-card-form-dropped-image-pending.png`](c9-card-form-dropped-image-pending.png) | [`c9-card-form-dropped-image-after-create.png`](c9-card-form-dropped-image-after-create.png) |
| Pick: the file input's `files` set from a `DataTransfer`, then a `change` event | Ticket editor | [`c9-ticket-editor-picked-image-pending.png`](c9-ticket-editor-picked-image-pending.png) | [`c9-ticket-editor-picked-image-after-save-rev3.png`](c9-ticket-editor-picked-image-after-save-rev3.png) |

The pasted image went through `uploadAttachment`. Its stored mime, width, height, bytes and SHA-256 match the real file:
[`c2-app-upload-metadata.txt`](c2-app-upload-metadata.txt).
