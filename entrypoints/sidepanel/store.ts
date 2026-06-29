// store.ts — the side panel's brain.
//
// The panel has no access to the page DOM, so it drives the in-page engine
// (engine.js) over messaging and reads/writes the persisted per-origin session
// directly in chrome.storage.local:
//
//   panel → engine   chrome.tabs.sendMessage(tabId, { cmd, ... })
//   engine → panel   chrome.runtime.onMessage  { type: "ce:update" | "ce:gone" }
//
// Everything imperative (messaging, the long-lived close-detection port, tab
// tracking, export/import) lives here behind reactive signals. Components read
// the signals and call the actions; they never touch chrome.* directly.

import { createContext, createSignal, useContext } from 'solid-js';
import type { Group, Row, UpdateMessage } from '@/utils/types';
import { getSession, getSessions, setSessions, SESSIONS_KEY } from '@/utils/sessions';
import { buildExport, bytesToDataUrl, mimeFor, readBundle } from '@/utils/bundle';

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;
const isRestricted = (url: string) =>
  RESTRICTED.test(url || '') || /https:\/\/chrome\.google\.com\/webstore/.test(url || '');

export interface Toast {
  id: number;
  message: string;
  kind?: 'err';
}

export function createPanelStore() {
  // ---- reactive state -------------------------------------------------------
  const [status, setStatus] = createSignal('—');
  const [blocked, setBlocked] = createSignal<string | null>(null);
  const [groups, setGroups] = createSignal<Group[]>([]);
  const [toasts, setToasts] = createSignal<Toast[]>([]);

  // ---- plain (non-reactive) runtime state -----------------------------------
  let myWindowId: number | null = null;
  let targetTabId: number | null = null;
  let active = false; // is the engine running in the target tab?
  let lastUpdate: UpdateMessage | null = null; // most recent ce:update (current page)
  let pendingFlash: { path: string; original: string } | null = null; // flash after navigating
  let panelPort: chrome.runtime.Port | null = null;
  let toastSeq = 0;

  // ---- toasts ---------------------------------------------------------------
  function toast(message: string, kind?: 'err') {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }

  // ---- close-detection port -------------------------------------------------
  // Lets the background worker tear the engine down when this panel closes.
  function connectPanelPort() {
    try {
      panelPort = chrome.runtime.connect({ name: 'copyedit-panel' });
      panelPort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        panelPort = null;
        connectPanelPort();
        reportTarget();
      });
    } catch {
      panelPort = null;
    }
  }
  function reportTarget() {
    if (!panelPort) return;
    try { panelPort.postMessage({ type: 'copyedit-target', tabId: targetTabId }); } catch {}
  }

  // ---- messaging ------------------------------------------------------------
  function sendToTab(msg: any): Promise<any> {
    return new Promise((resolve) => {
      if (targetTabId == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(targetTabId, msg, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ---- activation -----------------------------------------------------------
  // Inject the engine into the active tab, then sync state. While the panel is
  // open the tool is always active; closing the panel is how you stop.
  async function enterTab(tab?: chrome.tabs.Tab) {
    if (!tab || tab.id == null) {
      showBlocked('No active tab to edit.');
      return;
    }
    // No readable URL usually means a privileged page we have no host access to.
    if (!tab.url || isRestricted(tab.url)) {
      targetTabId = null;
      reportTarget();
      showBlocked("Copy Edit can't run on this page (restricted URL). Open a normal web page and try again.");
      return;
    }
    targetTabId = tab.id;
    reportTarget();
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['engine.js'] });
      active = true;
      setBlocked(null);
      await sendToTab({ cmd: 'getState' });
    } catch (err) {
      console.warn('[Copy Edit] could not start on this tab:', err);
      showBlocked("Couldn't start Copy Edit on this page.");
    }
  }

  async function init() {
    try {
      const win = await chrome.windows.getCurrent();
      myWindowId = win.id ?? null;
    } catch {}
    connectPanelPort();
    const [tab] = await chrome.tabs.query(
      myWindowId != null ? { active: true, windowId: myWindowId } : { active: true, currentWindow: true }
    );
    enterTab(tab);
  }

  // ---- rendering: rebuild groups + status from live + stored state ----------
  async function refresh() {
    if (!active || !lastUpdate) return;
    setBlocked(null);

    const u = lastUpdate;
    const session = await getSession(u.origin);
    const storedPages = (session && session.pages) || {};

    const next: Group[] = [];
    const currentRows: Row[] = (u.rows || []).map((r) => ({ ...r, _path: u.path }));
    if (currentRows.length) {
      next.push({ path: u.path, title: u.title, current: true, rows: currentRows });
    }
    for (const [path, pg] of Object.entries(storedPages).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (path === u.path) continue;
      const rows: Row[] = (pg.changes || []).map((c) => ({
        id: null,
        status: 'saved',
        kind: c.kind === 'image' ? 'image' : 'text',
        original: c.original,
        edited: c.edited,
        element: c.element || {},
        _path: path,
      }));
      if (rows.length) next.push({ path, title: pg.title, current: false, rows });
    }

    const total = next.reduce((n, g) => n + g.rows.length, 0);
    setStatus(total ? `${u.mode} · ${total}` : u.mode);
    setGroups(next);
  }

  function showBlocked(message: string) {
    setBlocked(message);
    setStatus('blocked');
  }

  function maybeFlash() {
    if (!pendingFlash || !lastUpdate || lastUpdate.path !== pendingFlash.path) return;
    const hit = (lastUpdate.rows || []).find((x) => x.id != null && x.original === pendingFlash!.original);
    if (hit) sendToTab({ cmd: 'locate', id: hit.id });
    pendingFlash = null;
  }

  // ---- toolbar actions ------------------------------------------------------
  async function doExport() {
    const origin = lastUpdate && lastUpdate.origin;
    const session = await getSession(origin);
    const result = buildExport(origin, session);
    if (!result) return toast('No changes to export yet.', 'err');

    const { json, zipped, pageCount, changeCount, imageCount } = result;
    const slug = (origin || 'site').replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([zipped as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.${stamp}.copyedit-bundle.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    const noun =
      `${changeCount} change${changeCount === 1 ? '' : 's'} across ${pageCount} page${pageCount === 1 ? '' : 's'}` +
      (imageCount ? ` (${imageCount} image${imageCount === 1 ? '' : 's'})` : '');
    try {
      await navigator.clipboard.writeText(json);
      toast(`Exported ${noun} — bundle downloaded + manifest copied to clipboard.`);
    } catch {
      toast(`Exported ${noun} — bundle downloaded.`);
    }
  }

  async function doClear() {
    const origin = lastUpdate && lastUpdate.origin;
    if (!origin) return;
    const session = await getSession(origin);
    const count = session
      ? Object.values(session.pages || {}).reduce((n, p) => n + (p.changes || []).length, 0)
      : 0;
    if (!count) return toast('Nothing to clear.');
    if (!confirm(`Clear all ${count} change(s) for ${origin}? This can't be undone.`)) return;

    const sessions = await getSessions();
    delete sessions[origin];
    await setSessions(sessions);
    await sendToTab({ cmd: 'reset' });
    toast('Session cleared.');
  }

  // ---- import (file picker + drag/drop) -------------------------------------
  async function applyFile(file: File) {
    let parsed;
    try {
      parsed = await readBundle(file);
    } catch (err: any) {
      const msg = err && err.message && /changeset\.json/.test(err.message)
        ? 'Bundle is missing changeset.json.'
        : 'Could not read that file (expected a .zip bundle or .json).';
      return toast(msg, 'err');
    }
    const { data, assets } = parsed;
    if (!data || data.format !== 'copy-edit-session' || !data.origin) {
      return toast("That isn't a Copy Edit changeset.", 'err');
    }

    const sessions = await getSessions();
    const session = sessions[data.origin] || { mode: 'edit', pages: {} };
    for (const pg of data.pages || []) {
      if (!pg || !pg.path) continue;
      session.pages[pg.path] = {
        title: pg.title || null,
        url: pg.url || (data.origin + pg.path),
        updatedAt: Date.now(),
        changes: (pg.changes || [])
          .map((c: any) => {
            if (c.kind === 'image') {
              let edited = c.edited;
              if (!edited && c.file && assets && assets[c.file]) {
                edited = bytesToDataUrl(assets[c.file], mimeFor(c.file, c.fileType));
              }
              return {
                kind: 'image', element: c.element, original: c.original, edited,
                alt: c.alt || null, fileName: c.fileName || null, fileType: c.fileType || null,
              };
            }
            return { element: c.element, original: c.original, edited: c.edited };
          })
          .filter((c: any) => c.edited != null),
      };
    }
    sessions[data.origin] = session;
    await setSessions(sessions);

    if (lastUpdate && lastUpdate.origin === data.origin && targetTabId != null) {
      try { chrome.tabs.reload(targetTabId); } catch {}
      toast('Imported — re-applying on this site.');
    } else {
      toast(`Imported ${data.summary?.changeCount ?? ''} change(s) for ${data.origin}. Visit that site to see them.`.replace('  ', ' '));
    }
  }

  // ---- row actions ----------------------------------------------------------
  function locate(id: string) {
    sendToTab({ cmd: 'locate', id });
  }

  // Navigate to another page in the session, then flash the matching change.
  function gotoChange(r: Row) {
    const origin = lastUpdate && lastUpdate.origin;
    if (!origin || targetTabId == null) return;
    pendingFlash = { path: r._path!, original: r.original };
    try { chrome.tabs.update(targetTabId, { url: origin + r._path }); } catch {}
  }

  async function removeChange(r: Row, isCurrent: boolean) {
    if (isCurrent) {
      // Current page: let the engine revert it (and re-persist).
      await sendToTab({ cmd: 'remove', id: r.id, original: r.original, edited: r.edited });
      return;
    }
    // Other page: edit storage directly.
    const origin = lastUpdate && lastUpdate.origin;
    const sessions = await getSessions();
    const session = sessions[origin];
    if (!session || !session.pages || !session.pages[r._path!]) return;
    const pg = session.pages[r._path!];
    pg.changes = (pg.changes || []).filter((c) => !(c.original === r.original && c.edited === r.edited));
    if (!pg.changes.length) delete session.pages[r._path!];
    sessions[origin] = session;
    await setSessions(sessions);
  }

  // ---- chrome listeners (live for the panel document's lifetime) ------------
  chrome.runtime.onMessage.addListener((msg: any, sender) => {
    if (!msg) return;
    if (sender.tab && targetTabId != null && sender.tab.id !== targetTabId) return;
    if (msg.type === 'ce:update') {
      active = true;
      lastUpdate = msg;
      refresh();
      maybeFlash();
    } else if (msg.type === 'ce:gone') {
      active = false;
      lastUpdate = null;
    }
  });

  // Re-render when the session changes (edits on another page, external clear).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SESSIONS_KEY]) refresh();
  });

  // Follow the active tab within this window.
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (myWindowId != null && windowId !== myWindowId) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      enterTab(tab);
    } catch {}
  });

  // A reload / navigation of our tab re-activates the engine on the fresh page.
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tabId !== targetTabId) return;
    if (myWindowId != null && tab.windowId !== myWindowId) return;
    if (info.status === 'complete') enterTab(tab);
  });

  return {
    // state
    status,
    blocked,
    groups,
    toasts,
    // lifecycle
    init,
    // actions
    doExport,
    doClear,
    applyFile,
    locate,
    gotoChange,
    removeChange,
  };
}

export type PanelStore = ReturnType<typeof createPanelStore>;

// Context so deeply-nested rows can reach actions without prop drilling.
const PanelContext = createContext<PanelStore>();
export { PanelContext };

export function usePanel(): PanelStore {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error('usePanel must be used within <PanelContext.Provider>');
  return ctx;
}
