/**
 * The local Dark Mechanicus source checkout (`window.dm.sourceCheckout`): the Git clone of Dark Mechanicus itself
 * that the person chose on this machine as the destination for corrective work aimed at Dark Mechanicus.
 *
 * Two things are kept apart. The **target** is portable: what the checkout is (its `project.json` identity), the same
 * in every clone on every machine, and what cross-repository records may name. The **local** mapping is
 * machine-local: where this machine finds that target. It never leaves this machine.
 *
 * Nothing clones, searches or redirects: a checkout that moved, vanished or changed is unavailable, with a recovery
 * step, until the person chooses it again.
 */
import type { TrackedFolderView } from './api'

/** What the checkout is, as any machine would name it. */
export interface SourceCheckoutTarget {
  kind: 'darkmechanicus_source'
  /** `projectId` from the checkout's `project.json`. */
  projectId: string
  /** `name` from the checkout's `project.json`. */
  projectName: string
}

/** Where this machine finds the target. Never exported or shared. */
interface SourceCheckoutLocal {
  /** Canonical real path; a tracked folder. */
  path: string
  /** Path with the home directory abbreviated to `~`. */
  displayPath: string
  associatedAt: string
}

/** Why a folder cannot be (or no longer is) the source checkout. */
export type SourceCheckoutProblem =
  /** The path is gone: the clone was moved, renamed or deleted. */
  | 'missing'
  /** The folder is still there under the same name in another letter case (it was renamed by case only); choose it again. */
  | 'renamed'
  /** The path now resolves to another real folder: a link or junction on it changed. */
  | 'relocated'
  /** The folder is no longer tracked by Dark Mechanicus. */
  | 'untracked'
  /** An installed or built copy of the app, not its source. */
  | 'installed_app'
  /** A folder or repository that is not a Git checkout of the Dark Mechanicus source. */
  | 'not_dm_source'
  /** A Dark Mechanicus checkout with no project record (it was never set up, or its `project.json` is gone). */
  | 'not_initialized'
  /** Its `project.json` cannot be read as a project record. */
  | 'unreadable_project'
  /** Another project now sits at the associated path. */
  | 'project_mismatch'

export interface SourceCheckoutView {
  /** `none`: nothing chosen yet. `available`: revalidated just now. `unavailable`: see `problem`. */
  status: 'none' | 'available' | 'unavailable'
  target: SourceCheckoutTarget | null
  local: SourceCheckoutLocal | null
  problem: SourceCheckoutProblem | null
  /** What is wrong, for the person; null when available or none. */
  message: string | null
  /** What the person can do about it; null when available. */
  recovery: string | null
}

/** The outcome of choosing a checkout, through the native dialog or among tracked folders. */
export type SourceCheckoutChoice =
  | { outcome: 'cancelled' }
  /** Associated; `added` is true when choosing it also started tracking the folder. */
  | { outcome: 'associated'; checkout: SourceCheckoutView; folder: TrackedFolderView; added: boolean }
  /**
   * The Dark Mechanicus source, tracked now but not set up: set it up the usual way (`initializeRepository`), then
   * associate the tracked folder. Nothing was associated.
   */
  | { outcome: 'needs_initialization'; folder: TrackedFolderView; added: boolean; message: string; recovery: string }
  /**
   * Not usable; nothing was associated. A folder dialog choice is inspected in full before it is tracked, so normally
   * nothing was tracked either; should the folder change between that check and tracking, `folder` names the folder
   * that choosing it tracked (`added`), so the folder list stays accurate.
   */
  | { outcome: 'refused'; problem: SourceCheckoutProblem; message: string; recovery: string; folder?: TrackedFolderView; added?: boolean }

export interface SourceCheckoutApi {
  /** The association, revalidated now. */
  get(): Promise<SourceCheckoutView>
  /**
   * Opens the native folder dialog in main and associates the chosen folder once it validates; a Dark Mechanicus
   * source folder that is not tracked yet is tracked first. Takes nothing: the renderer never names the path.
   */
  pick(): Promise<SourceCheckoutChoice>
  /** Associates a folder that is already tracked; any other path is refused with `unauthorized`. */
  associate(folder: string): Promise<SourceCheckoutChoice>
  /** Forgets the association (never the folder or its data) and returns the empty view. */
  clear(): Promise<SourceCheckoutView>
}
