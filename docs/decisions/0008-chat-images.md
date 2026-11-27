# 0008 — Images in GUI agent chats

- **Status:** accepted
- **Date:** 2026-11-27

## Context

The first GUI chats were text only. The protocol investigation that shaped them required a text-only composer and left
the CLIs' image blocks unused ([`agent-chat-protocols.md`](../reports/agent-chat-protocols.md): "Text-only GUI
composer is required", "images deliberately unused in v1"). A person could not paste the screenshot of a bug into a
chat, and the screenshots an agent's own tools produced (OMP's `read` of an image, Claude Code's Read) showed only as
a line of text. Both CLIs take and return images in their structured modes
([`agent-chat-images.md`](../reports/agent-chat-images.md) pins the wire contract). Images had to reach the agent and
the transcript without putting image bytes into chat items, IPC events or the chat index, and without turning every
chat screenshot into a portable project record.

## Decision

- **Ids only, everywhere but one channel.** This replaces the v1 text-only rule. A chat item, an `agentChat:event`, a
  snapshot and the stored chat index carry a `ChatImageRef` (`{ id, mime, width, height, bytes }`, id `ci_` plus 26
  base32 characters, `src/shared/agents/chat.ts`), never bytes or a path. Bytes cross IPC in exactly one place: the
  renderer stages each image with `agentChat:stageImage { folder, chatId, data }` (plain base64 of one image) and gets
  its ref back; `agentChat:send` then names at most 4 staged `imageIds` (a message may be images only). An id the chat
  does not hold is refused (`invalid_input`) before anything is written. Main alone reads the bytes back to build the
  turn: Claude Code gets one stream-json `user` line with the image blocks before the text; Skitarii (OMP) gets one
  `prompt` (or `follow_up`) line with `images`, written as **one unsplit line** because OMP refuses host-to-CLI
  `rpc_chunk` frames, and refused with `image_too_large` only above the CLI's `maxReassembledFrameBytes` (64 MiB),
  which DM's own limits keep out of reach.
- **Limits.** An image the person sends is PNG or JPEG, judged by its bytes, at most 10 MiB and 8000 pixels per side,
  the same intake as [0006](0006-image-attachments.md). An image an agent's tool returns may also be WebP (OMP's `read`
  returns WebP); at most 8 are lifted from one tool result, and anything else shows as `1 image (<mime>, not shown)`.
- **A chat image store, not the attachments table.** `chatImages` (`src/main/agentChat/chatImages.ts`) writes each
  image as a private file (`0600`) under `userData/agents/chat-images/<folder store id>/<chat id>/<image id>.<ext>`
  (`projectless` for a project-less chat). It is never in a folder's portable records, has no owner record, is not
  pruned, and is deleted with its chat. The renderer reads it only through the privileged, read-only
  `dm-chat-image://<folder key>/<chat id>/<image id>` scheme (the folder's per-run key, or `projectless`; GET only,
  `nosniff`, unknown or traversing addresses answer 404), allowed by the CSP's `img-src` next to `dm-attachment:`.
- **Why not folder attachments.** A [0006](0006-image-attachments.md) attachment is a record with an owner that travels
  through Git and between machines, pruned when nothing claims it. A chat image is part of one machine's conversation,
  like the chat record and its transcript: it has no plan, ticket or attempt to own it, it can hold anything that was on
  the screen, and committing every pasted screenshot would grow the repository and publish it. An image becomes a
  portable attachment only when the person chooses so: **Attach as evidence** (`agentChat:attachEvidence`, a chat
  bound to the epic, PNG or JPEG only) uploads it through `uploadAttachment` as `evidence` on a comment on the ticket
  of its verified worker thread, or on the epic.
- **Images cannot be secret-masked.** Masking (`maskAgentChatSecretsDeep`, claim-token masking) works on text: it
  covers an item's text and image refs, never the pixels. A screenshot that shows a token, a password or a private
  page is stored, shown and sent to the agent's provider as it is. Attach as evidence copies it, unmasked, into the
  project's records.

## Consequences

- A person can show an agent the screen they mean, and sees the images an agent's tools read, inline, with a lightbox.
- IPC, the chat index and every event stay small and text-maskable; a test asserts that no base64 reaches the chat
  store.
- Chat images stay on the machine that took them, as the chats do; an image whose file is gone shows a broken-image
  placeholder.
- Images that were staged and never sent stay on disk until their chat is deleted.
- Look at a screenshot before you send or attach it: nothing redacts it for you.
- Images need no role guide change and no skills version bump: the person sends them, and the agent receives them
  through its own CLI.
