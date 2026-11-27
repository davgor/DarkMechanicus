/**
 * The address of an image main holds for a chat: `dm-chat-image://<folder key>/<chat id>/<image id>`. The host is
 * the folder's per-run attachment key (see `TrackedFolderView.attachmentKey`), never a path, or `projectless` for a
 * chat of no folder. Shared by main (which serves the scheme) and the renderer (which builds the addresses).
 */
export const CHAT_IMAGE_SCHEME = 'dm-chat-image'

/** The host of a project-less chat's images; an attachment key is hex, so it never collides. */
const PROJECTLESS_HOST = 'projectless'

export function chatImageUrl(folderKey: string | null, chatId: string, imageId: string): string {
  return `${CHAT_IMAGE_SCHEME}://${folderKey ?? PROJECTLESS_HOST}/${chatId}/${imageId}`
}
