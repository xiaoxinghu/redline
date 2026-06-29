// Shared domain types for Copy Edit.
//
// These describe the data contracts that travel between the three runtime
// contexts (engine ⇄ panel ⇄ storage/export). The DOM-heavy bodies of the
// engine and panel stay loosely typed, but the *shapes* below are the real
// interface and are worth keeping honest.

export type Mode = 'edit' | 'preview' | 'diff';
export type ChangeKind = 'text' | 'image';
export type RowStatus = 'applied' | 'saved' | 'warning';

/** Identity of the element a change targets (computed on the pristine DOM). */
export interface ElementDescriptor {
  tag?: string;
  id?: string | null;
  classes?: string[];
  componentHint?: string | null;
  attributes?: Record<string, string>;
  selector?: string;
  domPath?: string;
  elementText?: string;
  textIndex?: number;
  context?: {
    nearestHeading?: string | null;
    landmark?: string | null;
  };
}

/** A single saved change, as persisted in storage. */
export interface Change {
  kind?: ChangeKind;
  element: ElementDescriptor;
  original: string;
  edited: string;
  // Image-only fields:
  alt?: string | null;
  fileName?: string | null;
  fileType?: string | null;
}

/** One page within an origin's session. */
export interface Page {
  title?: string | null;
  url?: string;
  updatedAt?: number;
  changes: Change[];
}

/** Per-origin session: the editing mode + a page map keyed by pathname. */
export interface Session {
  mode: Mode;
  pages: Record<string, Page>;
}

/** Top-level storage value under `copyedit_sessions`. */
export type Sessions = Record<string, Session>;

/** A row the engine reports to the panel for the current page. */
export interface Row {
  id: string | null;
  status: RowStatus;
  kind?: ChangeKind;
  previewBlocked?: boolean;
  original: string;
  edited: string;
  element: ElementDescriptor;
  /** Set by the panel when grouping off-page rows. */
  _path?: string;
}

/** engine → panel: live state of the current page. */
export interface UpdateMessage {
  type: 'ce:update';
  origin: string;
  path: string;
  url: string;
  title: string;
  mode: Mode;
  rows: Row[];
}

/** engine → panel: the engine was torn down. */
export interface GoneMessage {
  type: 'ce:gone';
}

export type EngineToPanel = UpdateMessage | GoneMessage;

/** panel → engine commands. */
export type PanelCommand =
  | { cmd: 'getState' }
  | { cmd: 'setMode'; mode: Mode }
  | { cmd: 'locate'; id: string }
  | { cmd: 'remove'; id: string | null; original?: string; edited?: string }
  | { cmd: 'reset' }
  | { cmd: 'teardown' };

declare global {
  interface Window {
    __copyEditTool?: { teardown: () => void; pushUpdate: () => void };
  }
}
