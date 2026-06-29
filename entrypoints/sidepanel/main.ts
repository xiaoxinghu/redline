// main.ts — the Copy Edit UI, living in Chrome's Side Panel.
//
// The panel owns the toolbar + the cross-page change list. It has no access to
// the page DOM, so it drives the in-page engine (engine.js, built from
// entrypoints/engine.ts) over messaging and reads/writes the persisted session
// directly in chrome.storage.local:
//
//   panel → engine   chrome.tabs.sendMessage(tabId, { cmd, ... })
//   engine → panel   chrome.runtime.onMessage  { type: "ce:update" | "ce:gone" }
//
// SESSIONS are per origin (copyedit_sessions[origin] = { mode, pages }). The
// list groups changes by page; the current page's rows come live from the
// engine (with ids + applied/warning status), other pages come from storage.
// Closing the panel tears the engine down (background.ts) — the site goes back
// to normal while the session waits in storage. "Stopped" = panel closed.

import './style.css';
import { zipSync, unzipSync } from '@/utils/zip';

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;
const isRestricted = (url: string) =>
  RESTRICTED.test(url || '') || /https:\/\/chrome\.google\.com\/webstore/.test(url || '');
const SESSIONS_KEY = 'copyedit_sessions';

const $ = (id: string): any => document.getElementById(id);
const els = {
  status: $('status'),
  export: $('export'),
  import: $('import'),
  clear: $('clear'),
  list: $('list'),
  empty: $('empty'),
  blocked: $('blocked'),
  blockedMsg: $('blocked-msg'),
  toasts: $('toasts'),
  drop: $('drop'),
  file: $('file'),
};

let myWindowId: number | null = null;
let targetTabId: number | null = null;
let active = false;            // is the engine running in the target tab?
let lastUpdate: any = null;    // most recent ce:update payload (current page)
let pendingFlash: any = null;  // { path, original } — flash after navigating

// Long-lived port so the background worker can detect when this panel closes
// (toolbar icon, ✕, or switching panels) and tear the engine down — closing the
// editor returns the page to normal. We keep it told which tab we're driving.
let panelPort: any = null;
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

// ======================================================================
// Storage (per-origin sessions)
// ======================================================================
function getSessions(): Promise<any> {
  return new Promise((res) => {
    try { chrome.storage.local.get(SESSIONS_KEY, (r) => res((r && r[SESSIONS_KEY]) || {})); }
    catch { res({}); }
  });
}
function setSessions(obj: any): Promise<void> {
  return new Promise((res) => {
    try { chrome.storage.local.set({ [SESSIONS_KEY]: obj }, () => res()); } catch { res(); }
  });
}
async function getSession(origin: string) {
  if (!origin) return null;
  const s = await getSessions();
  return s[origin] || null;
}

// ======================================================================
// Diff (kept in sync with engine.ts; used to render rows + export preview)
// ======================================================================
function tokenize(s: string) { return (s || '').match(/(\s+|[^\s]+)/g) || []; }
function diffParts(original: string, edited: string) {
  const a = tokenize(original), b = tokenize(edited);
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    const out = [];
    if (n) out.push({ op: '-', text: a.join('') });
    if (m) out.push({ op: '+', text: b.join('') });
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ op: '=', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ op: '-', text: a[i] }); i++; }
    else { raw.push({ op: '+', text: b[j] }); j++; }
  }
  while (i < n) raw.push({ op: '-', text: a[i++] });
  while (j < m) raw.push({ op: '+', text: b[j++] });
  const merged: { op: string; text: string }[] = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === p.op) last.text += p.text;
    else merged.push({ ...p });
  }
  return merged;
}
function diffNodes(original: string, edited: string) {
  const frag = document.createDocumentFragment();
  for (const t of diffParts(original, edited)) {
    if (t.op === '=') frag.appendChild(document.createTextNode(t.text));
    else {
      const el = document.createElement(t.op === '+' ? 'ins' : 'del');
      el.textContent = t.text;
      frag.appendChild(el);
    }
  }
  return frag;
}
function diffPreview(original: string, edited: string) {
  return diffParts(original, edited)
    .map((p) => (p.op === '=' ? p.text : p.op === '+' ? `[+${p.text}]` : `[-${p.text}]`))
    .join('');
}

// ======================================================================
// Image bytes <-> data URL + filename helpers (for the export/import bundle)
// ======================================================================
function dataUrlToBytes(dataUrl: string) {
  const b64 = (dataUrl || '').split(',')[1] || '';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as any);
  return `data:${mime || 'image/png'};base64,` + btoa(bin);
}
const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp' };
function extFor(mime: string, fileName: string) {
  if (fileName && /\.[a-z0-9]+$/i.test(fileName)) return fileName.split('.').pop()!.toLowerCase();
  return EXT_BY_MIME[mime] || 'png';
}
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' };
function mimeFor(file: string, fileType?: string) {
  if (fileType) return fileType;
  const ext = (file.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'image/png';
}

// ======================================================================
// Messaging
// ======================================================================
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

chrome.runtime.onMessage.addListener((msg: any, sender) => {
  if (!msg) return;
  if (sender.tab && targetTabId != null && sender.tab.id !== targetTabId) return;
  if (msg.type === 'ce:update') {
    active = true;
    lastUpdate = msg;
    render();
    maybeFlash();
  } else if (msg.type === 'ce:gone') {
    active = false;
    lastUpdate = null;
  }
});

// Re-render when the session changes (e.g. edits on another page, external clear).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SESSIONS_KEY]) render();
});

// ======================================================================
// Activation — inject the engine into the active tab, then sync state.
// While the panel is open the tool is always active (one of edit/preview/diff);
// closing the panel is how you stop.
// ======================================================================
async function enterTab(tab: any) {
  if (!tab || tab.id == null) {
    showBlocked('No active tab to edit.');
    return;
  }
  // No readable URL usually means a privileged page (chrome://, web store, etc.)
  // we have no host access to — treat it the same as an explicitly restricted URL.
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
    hideBlocked();
    await sendToTab({ cmd: 'getState' });
  } catch (err) {
    // Injection can still fail on pages we couldn't pre-screen (e.g. the URL was
    // hidden from us). This is expected, not a real fault — keep it quiet.
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

// ======================================================================
// Toolbar actions
// ======================================================================
els.export.addEventListener('click', doExport);
els.import.addEventListener('click', () => els.file.click());
els.clear.addEventListener('click', doClear);

// ======================================================================
// Export — the whole origin session as one file
// ======================================================================
async function doExport() {
  const origin = lastUpdate && lastUpdate.origin;
  const session = await getSession(origin);
  const pages = session ? session.pages || {} : {};
  const entries = Object.entries(pages).filter(([, pg]: any) => (pg.changes || []).length);
  if (!entries.length) return toast('No changes to export yet.', 'err');

  const assets: Record<string, Uint8Array> = {}; // zip path -> Uint8Array
  let imgCount = 0;

  const outPages = entries.map(([path, pg]: any) => {
    const changes = (pg.changes || []).map((c: any, i: number) => {
      if (c.kind === 'image') {
        imgCount++;
        const ext = extFor(c.fileType, c.fileName);
        const file = `assets/img-${imgCount}.${ext}`;
        try { assets[file] = dataUrlToBytes(c.edited); } catch {}
        return {
          index: i + 1, kind: 'image',
          original: c.original, file,
          alt: c.alt || null, fileName: c.fileName || null, fileType: c.fileType || null,
          element: c.element,
        };
      }
      return {
        index: i + 1, kind: 'text',
        original: c.original, edited: c.edited,
        diffPreview: diffPreview(c.original, c.edited),
        element: c.element,
      };
    });
    return { path, title: pg.title || null, url: pg.url || (origin + path), changes };
  });
  const changeCount = outPages.reduce((n, p) => n + p.changes.length, 0);

  const out = {
    format: 'copy-edit-session',
    version: 2,
    readme:
      'Copy Edit bundle — text + image changes a content editor made across one site. ' +
      'Text changes carry the exact `original`/`edited` strings. Image changes carry the ' +
      'original `original` src and a `file` pointing at the replacement image under assets/ ' +
      'in this zip. To locate in source: search the codebase for the `original` text (for ' +
      'images, use `element.selector`/`element.componentHint`/`element.attributes`). ' +
      'Re-import this .zip into Copy Edit to re-apply.',
    origin,
    exportedAt: new Date().toISOString(),
    summary: { pageCount: outPages.length, changeCount, imageCount: imgCount },
    pages: outPages,
  };

  const json = JSON.stringify(out, null, 2);
  assets['changeset.json'] = new TextEncoder().encode(json);
  const zipped = zipSync(assets);

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
    `${changeCount} change${changeCount === 1 ? '' : 's'} across ${outPages.length} page${outPages.length === 1 ? '' : 's'}` +
    (imgCount ? ` (${imgCount} image${imgCount === 1 ? '' : 's'})` : '');
  try {
    await navigator.clipboard.writeText(json);
    toast(`Exported ${noun} — bundle downloaded + manifest copied to clipboard.`);
  } catch {
    toast(`Exported ${noun} — bundle downloaded.`);
  }
}

// ======================================================================
// Clear — wipe this origin's session
// ======================================================================
async function doClear() {
  const origin = lastUpdate && lastUpdate.origin;
  if (!origin) return;
  const session = await getSession(origin);
  const count = session
    ? Object.values(session.pages || {}).reduce((n: number, p: any) => n + (p.changes || []).length, 0)
    : 0;
  if (!count) return toast('Nothing to clear.');
  if (!confirm(`Clear all ${count} change(s) for ${origin}? This can't be undone.`)) return;

  const sessions = await getSessions();
  delete sessions[origin];
  await setSessions(sessions);
  await sendToTab({ cmd: 'reset' });
  toast('Session cleared.');
}

// ======================================================================
// Import — merge a session file into storage, re-apply if it's this origin
// ======================================================================
els.file.addEventListener('change', async () => {
  const f = els.file.files[0];
  if (!f) return;
  await applyFile(f);
  els.file.value = '';
});

async function applyFile(file: File) {
  let data: any, assets: any = null;
  try {
    if (await isZipFile(file)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const files = unzipSync(bytes);
      const name =
        Object.keys(files).find((n) => /(^|\/)changeset\.json$/i.test(n)) ||
        Object.keys(files).find((n) => /\.json$/i.test(n));
      if (!name) return toast('Bundle is missing changeset.json.', 'err');
      data = JSON.parse(new TextDecoder().decode(files[name]));
      assets = files;
    } else {
      data = JSON.parse(await file.text());
    }
  } catch {
    return toast('Could not read that file (expected a .zip bundle or .json).', 'err');
  }
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

// A bundle is a zip; a legacy session is plain JSON. Sniff by extension, then
// by the "PK" magic bytes so a renamed/typeless file still routes correctly.
async function isZipFile(file: File) {
  if (/\.zip$/i.test(file.name)) return true;
  if (/\.json$/i.test(file.name)) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b; // "PK"
  } catch { return false; }
}

// Drag a session file onto the panel.
let dragDepth = 0;
window.addEventListener('dragover', (e: DragEvent) => {
  if (![...e.dataTransfer!.types].includes('Files')) return;
  e.preventDefault();
  els.drop.hidden = false;
});
window.addEventListener('dragenter', (e: DragEvent) => {
  if (![...e.dataTransfer!.types].includes('Files')) return;
  dragDepth++;
  els.drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; els.drop.hidden = true; }
});
window.addEventListener('drop', (e: DragEvent) => {
  if (!e.dataTransfer!.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  applyFile(e.dataTransfer!.files[0]);
});

// ======================================================================
// Rendering
// ======================================================================
function showBlocked(message: string) {
  els.blockedMsg.textContent = message;
  els.blocked.hidden = false;
  els.list.hidden = true;
  els.empty.hidden = true;
  els.status.textContent = 'blocked';
  for (const b of [els.export, els.import, els.clear]) {
    b.disabled = true; b.style.opacity = '0.45'; b.style.pointerEvents = 'none';
  }
}
function hideBlocked() {
  if (els.blocked.hidden) return;
  els.blocked.hidden = true;
  for (const b of [els.export, els.import, els.clear]) {
    b.disabled = false; b.style.opacity = ''; b.style.pointerEvents = '';
  }
}

async function render() {
  if (!active || !lastUpdate) return;
  hideBlocked();

  const u = lastUpdate;

  // Gather all pages for this origin from storage, then override the current
  // page with the live rows from the engine.
  const session = await getSession(u.origin);
  const storedPages = (session && session.pages) || {};

  const groups = [];
  const currentRows = (u.rows || []).map((r: any) => ({ ...r, _path: u.path }));
  // Current page first.
  if (currentRows.length) {
    groups.push({ path: u.path, title: u.title, current: true, rows: currentRows });
  }
  // Other pages (alphabetical), from storage.
  for (const [path, pg] of Object.entries(storedPages).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (path === u.path) continue;
    const rows = ((pg as any).changes || []).map((c: any) => ({
      id: null,
      status: 'saved',
      kind: c.kind === 'image' ? 'image' : 'text',
      original: c.original,
      edited: c.edited,
      element: c.element || {},
      _path: path,
    }));
    if (rows.length) groups.push({ path, title: (pg as any).title, current: false, rows });
  }

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  els.status.textContent = total ? `${u.mode} · ${total}` : u.mode;

  if (!total) {
    els.list.hidden = true;
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.list.hidden = false;

  els.list.innerHTML = '';
  for (const g of groups) els.list.appendChild(renderGroup(g));
}

function renderGroup(g: any) {
  const wrap = document.createElement('section');
  wrap.className = 'group';

  const head = document.createElement('div');
  head.className = 'group-head';
  const path = document.createElement('span');
  path.className = 'group-path';
  path.textContent = g.path;
  if (g.title) path.title = g.title;
  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(g.rows.length);
  head.append(path, count);
  if (g.current) {
    const here = document.createElement('span');
    here.className = 'group-here';
    here.textContent = 'this page';
    head.appendChild(here);
  }
  wrap.appendChild(head);

  for (const r of g.rows) wrap.appendChild(renderRow(r, g.current));
  return wrap;
}

function renderRow(r: any, isCurrent: boolean) {
  const el = r.element || {};
  const row = document.createElement('div');
  row.className = 'row' + (isCurrent ? '' : ' offpage');

  const top = document.createElement('div');
  top.className = 'top';

  if (r.status === 'warning') {
    const badge = document.createElement('span');
    badge.className = 'badge miss';
    badge.textContent = 'needs attention';
    badge.title = "Saved edit couldn't be applied on this page (text changed or element gone).";
    top.appendChild(badge);
  } else if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'badge ok';
    badge.textContent = 'applied';
    top.appendChild(badge);
  }

  if (r.kind === 'image') {
    const ib = document.createElement('span');
    ib.className = 'badge img';
    ib.textContent = 'image';
    top.appendChild(ib);
  }

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `<${el.tag || '?'}>` + (el.componentHint ? ` · ${el.componentHint}` : '');
  top.appendChild(tag);

  const action = document.createElement('button');
  action.className = 'locate';
  if (isCurrent && r.id) {
    action.textContent = 'Locate ↧';
    action.title = 'Scroll to this change on the page';
    action.addEventListener('click', (e) => { e.stopPropagation(); sendToTab({ cmd: 'locate', id: r.id }); });
    top.appendChild(action);
  } else if (!isCurrent) {
    action.textContent = 'Go ↗';
    action.title = 'Open this page and highlight the change';
    action.addEventListener('click', (e) => { e.stopPropagation(); gotoChange(r); });
    top.appendChild(action);
  }

  const remove = document.createElement('button');
  remove.className = 'rowx';
  remove.textContent = '✕';
  remove.title = 'Remove this change';
  remove.addEventListener('click', (e) => { e.stopPropagation(); removeChange(r, isCurrent); });
  top.appendChild(remove);

  row.appendChild(top);

  const mini = document.createElement('div');
  if (r.kind === 'image') {
    mini.className = 'mini img';
    const before = document.createElement('img');
    before.className = 'thumb';
    before.alt = 'before';
    if (r.original) before.src = r.original;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '\u2192';
    const after = document.createElement('img');
    after.className = 'thumb';
    after.alt = 'after';
    if (r.edited) after.src = r.edited;
    mini.append(before, arrow, after);
  } else {
    mini.className = 'mini';
    mini.appendChild(diffNodes(r.original, r.edited));
  }
  row.appendChild(mini);

  if (r.kind === 'image' && r.previewBlocked) {
    const note = document.createElement('div');
    note.className = 'ctx warn';
    note.textContent = 'Preview blocked on the live site \u2014 saved & will be exported.';
    row.appendChild(note);
  }

  const sel = document.createElement('div');
  sel.className = 'sel';
  sel.textContent = el.selector || el.domPath || '(no selector)';
  row.appendChild(sel);

  if (el.context && el.context.nearestHeading) {
    const ctx = document.createElement('div');
    ctx.className = 'ctx';
    ctx.textContent = 'under: ' + el.context.nearestHeading;
    row.appendChild(ctx);
  }

  // Clicking an off-page row navigates to it.
  if (!isCurrent) row.addEventListener('click', () => gotoChange(r));
  return row;
}

// Navigate to another page in the session, then flash the matching change.
function gotoChange(r: any) {
  const origin = lastUpdate && lastUpdate.origin;
  if (!origin || targetTabId == null) return;
  pendingFlash = { path: r._path, original: r.original };
  try { chrome.tabs.update(targetTabId, { url: origin + r._path }); } catch {}
}

function maybeFlash() {
  if (!pendingFlash || !lastUpdate || lastUpdate.path !== pendingFlash.path) return;
  const hit = (lastUpdate.rows || []).find((x: any) => x.id != null && x.original === pendingFlash.original);
  if (hit) sendToTab({ cmd: 'locate', id: hit.id });
  pendingFlash = null;
}

async function removeChange(r: any, isCurrent: boolean) {
  if (isCurrent) {
    // Current page: let the engine revert it (and re-persist).
    await sendToTab({ cmd: 'remove', id: r.id, original: r.original, edited: r.edited });
    return;
  }
  // Other page: edit storage directly.
  const origin = lastUpdate && lastUpdate.origin;
  const sessions = await getSessions();
  const session = sessions[origin];
  if (!session || !session.pages || !session.pages[r._path]) return;
  const pg = session.pages[r._path];
  pg.changes = (pg.changes || []).filter((c: any) => !(c.original === r.original && c.edited === r.edited));
  if (!pg.changes.length) delete session.pages[r._path];
  sessions[origin] = session;
  await setSessions(sessions);
}

// ======================================================================
// Toasts
// ======================================================================
function toast(message: string, kind?: string) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ======================================================================
init();
