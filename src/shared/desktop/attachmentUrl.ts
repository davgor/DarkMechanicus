/**
 * The address of a stored image: `dm-attachment://<folder key>/<attachment id>`. The host is the folder's
 * opaque attachment key (see `TrackedFolderView.attachmentKey`), never a path. Shared by main (which serves
 * the scheme) and the renderer (which builds the addresses).
 */
export const ATTACHMENT_SCHEME = 'dm-attachment'

export function attachmentUrl(folderKey: string, attachmentId: string): string {
  return `${ATTACHMENT_SCHEME}://${folderKey}/${attachmentId}`
}
