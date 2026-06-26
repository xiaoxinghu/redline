// sidepanel.js — the Copy Edit UI, living in Chrome's Side Panel.
//
// The panel owns the toolbar + the cross-page change list. It has no access to
// the page DOM, so it drives the in-page engine (content.js) over messaging and
// reads/writes the persisted session directly in chrome.storage.local:
//
//   panel → engine   chrome.tabs.sendMessage(tabId, { cmd, ... })
//   engine → panel   chrome.runtime.onMessage  { type: "ce:update" | "ce:gone" }
//
// SESSIONS are per origin (copyedit_sessions[origin] = { mode, pages }). The
// list groups changes by page; the current page's rows come live from the
// engine (with ids + applied/warning status), other pages come from storage.
// Closing the panel tears the engine down (background.js) — the site goes back
// to normal while the session waits in storage. "Stopped" = panel closed.

"use strict";

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;
const isRestricted = (url) =>
  RESTRICTED.test(url || "") || /https:\/\/chrome\.google\.com\/webstore/.test(url || "");
const SESSIONS_KEY = "copyedit_sessions";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  export: $("export"),
  import: $("import"),
  clear: $("clear"),
  list: $("list"),
  empty: $("empty"),
  blocked: $("blocked"),
  blockedMsg: $("blocked-msg"),
  toasts: $("toasts"),
  drop: $("drop"),
  file: $("file"),
};

let myWindowId = null;
let targetTabId = null;
let active = false;            // is the engine running in the target tab?
let lastUpdate = null;         // most recent ce:update payload (current page)
let pendingFlash = null;       // { path, original } — flash after navigating

// Long-lived port so the background worker can detect when this panel closes
// (toolbar icon, ✕, or switching panels) and tear the engine down — closing the
// editor returns the page to normal. We keep it told which tab we're driving.
let panelPort = null;
function connectPanelPort() {
  try {
    panelPort = chrome.runtime.connect({ name: "copyedit-panel" });
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
  try { panelPort.postMessage({ type: "copyedit-target", tabId: targetTabId }); } catch {}
}

// ======================================================================
// Storage (per-origin sessions)
// ======================================================================
function getSessions() {
  return new Promise((res) => {
    try { chrome.storage.local.get(SESSIONS_KEY, (r) => res((r && r[SESSIONS_KEY]) || {})); }
    catch { res({}); }
  });
}
function setSessions(obj) {
  return new Promise((res) => {
    try { chrome.storage.local.set({ [SESSIONS_KEY]: obj }, res); } catch { res(); }
  });
}
async function getSession(origin) {
  if (!origin) return null;
  const s = await getSessions();
  return s[origin] || null;
}

// ======================================================================
// Diff (kept in sync with content.js; used to render rows + export preview)
// ======================================================================
function tokenize(s) { return (s || "").match(/(\s+|[^\s]+)/g) || []; }
function diffParts(original, edited) {
  const a = tokenize(original), b = tokenize(edited);
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    const out = [];
    if (n) out.push({ op: "-", text: a.join("") });
    if (m) out.push({ op: "+", text: b.join("") });
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ op: "=", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ op: "-", text: a[i] }); i++; }
    else { raw.push({ op: "+", text: b[j] }); j++; }
  }
  while (i < n) raw.push({ op: "-", text: a[i++] });
  while (j < m) raw.push({ op: "+", text: b[j++] });
  const merged = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === p.op) last.text += p.text;
    else merged.push({ ...p });
  }
  return merged;
}
function diffNodes(original, edited) {
  const frag = document.createDocumentFragment();
  for (const t of diffParts(original, edited)) {
    if (t.op === "=") frag.appendChild(document.createTextNode(t.text));
    else {
      const el = document.createElement(t.op === "+" ? "ins" : "del");
      el.textContent = t.text;
      frag.appendChild(el);
    }
  }
  return frag;
}
function diffPreview(original, edited) {
  return diffParts(original, edited)
    .map((p) => (p.op === "=" ? p.text : p.op === "+" ? `[+${p.text}]` : `[-${p.text}]`))
    .join("");
}

// ======================================================================
// Messaging
// ======================================================================
function sendToTab(msg) {
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

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (sender.tab && targetTabId != null && sender.tab.id !== targetTabId) return;
  if (msg.type === "ce:update") {
    active = true;
    lastUpdate = msg;
    render();
    maybeFlash();
  } else if (msg.type === "ce:gone") {
    active = false;
    lastUpdate = null;
  }
});

// Re-render when the session changes (e.g. edits on another page, external clear).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SESSIONS_KEY]) render();
});

// ======================================================================
// Activation — inject the engine into the active tab, then sync state.
// While the panel is open the tool is always active (one of edit/preview/diff);
// closing the panel is how you stop.
// ======================================================================
async function enterTab(tab) {
  if (!tab || tab.id == null) {
    showBlocked("No active tab to edit.");
    return;
  }
  if (isRestricted(tab.url)) {
    targetTabId = null;
    reportTarget();
    showBlocked("Copy Edit can't run on this page (restricted URL). Open a normal web page and try again.");
    return;
  }
  targetTabId = tab.id;
  reportTarget();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    active = true;
    hideBlocked();
    await sendToTab({ cmd: "getState" });
  } catch (err) {
    console.error("[Copy Edit] could not start on this tab:", err);
    showBlocked("Couldn't start Copy Edit on this page.");
  }
}

async function init() {
  try {
    const win = await chrome.windows.getCurrent();
    myWindowId = win.id;
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
  if (info.status === "complete") enterTab(tab);
});

// ======================================================================
// Toolbar actions
// ======================================================================
els.export.addEventListener("click", doExport);
els.import.addEventListener("click", () => els.file.click());
els.clear.addEventListener("click", doClear);

// ======================================================================
// Export — the whole origin session as one file
// ======================================================================
async function doExport() {
  const origin = lastUpdate && lastUpdate.origin;
  const session = await getSession(origin);
  const pages = session ? session.pages || {} : {};
  const entries = Object.entries(pages).filter(([, pg]) => (pg.changes || []).length);
  if (!entries.length) return toast("No changes to export yet.", "err");

  const outPages = entries.map(([path, pg]) => ({
    path,
    title: pg.title || null,
    url: pg.url || (origin + path),
    changes: (pg.changes || []).map((c, i) => ({
      index: i + 1,
      original: c.original,
      edited: c.edited,
      diffPreview: diffPreview(c.original, c.edited),
      element: c.element,
    })),
  }));
  const changeCount = outPages.reduce((n, p) => n + p.changes.length, 0);

  const out = {
    format: "copy-edit-session",
    version: 1,
    readme:
      "Copy Edit session — text changes a content editor made across one site. " +
      "Each page lists changes with the exact `original` and `edited` text. " +
      "To locate in source: search the codebase for the `original` string. " +
      "`element.selector`/`element.domPath`/`element.componentHint`/`element.attributes` " +
      "help identify the component that renders it. Re-import this file to re-apply.",
    origin,
    exportedAt: new Date().toISOString(),
    summary: { pageCount: outPages.length, changeCount },
    pages: outPages,
  };

  const json = JSON.stringify(out, null, 2);
  const slug = (origin || "site").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.${stamp}.copyedit-session.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  const noun = `${changeCount} change${changeCount === 1 ? "" : "s"} across ${outPages.length} page${outPages.length === 1 ? "" : "s"}`;
  try {
    await navigator.clipboard.writeText(json);
    toast(`Exported ${noun} — file downloaded + copied to clipboard.`);
  } catch {
    toast(`Exported ${noun} — file downloaded.`);
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
    ? Object.values(session.pages || {}).reduce((n, p) => n + (p.changes || []).length, 0)
    : 0;
  if (!count) return toast("Nothing to clear.");
  if (!confirm(`Clear all ${count} change(s) for ${origin}? This can't be undone.`)) return;

  const sessions = await getSessions();
  delete sessions[origin];
  await setSessions(sessions);
  await sendToTab({ cmd: "reset" });
  toast("Session cleared.");
}

// ======================================================================
// Import — merge a session file into storage, re-apply if it's this origin
// ======================================================================
els.file.addEventListener("change", async () => {
  const f = els.file.files[0];
  if (!f) return;
  await applyFile(f);
  els.file.value = "";
});

async function applyFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("Could not read that file as JSON.", "err");
  }
  if (!data || data.format !== "copy-edit-session" || !data.origin) {
    return toast("That isn't a Copy Edit session file.", "err");
  }

  const sessions = await getSessions();
  const session = sessions[data.origin] || { mode: "edit", pages: {} };
  for (const pg of data.pages || []) {
    if (!pg || !pg.path) continue;
    session.pages[pg.path] = {
      title: pg.title || null,
      url: pg.url || (data.origin + pg.path),
      updatedAt: Date.now(),
      changes: (pg.changes || []).map((c) => ({ element: c.element, original: c.original, edited: c.edited })),
    };
  }
  sessions[data.origin] = session;
  await setSessions(sessions);

  if (lastUpdate && lastUpdate.origin === data.origin && targetTabId != null) {
    try { chrome.tabs.reload(targetTabId); } catch {}
    toast("Imported — re-applying on this site.");
  } else {
    toast(`Imported ${data.summary?.changeCount ?? ""} change(s) for ${data.origin}. Visit that site to see them.`.replace("  ", " "));
  }
}

// Drag a session file onto the panel.
let dragDepth = 0;
window.addEventListener("dragover", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  els.drop.hidden = false;
});
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  els.drop.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; els.drop.hidden = true; }
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  applyFile(e.dataTransfer.files[0]);
});

// ======================================================================
// Rendering
// ======================================================================
function showBlocked(message) {
  els.blockedMsg.textContent = message;
  els.blocked.hidden = false;
  els.list.hidden = true;
  els.empty.hidden = true;
  els.status.textContent = "blocked";
  for (const b of [els.export, els.import, els.clear]) {
    b.disabled = true; b.style.opacity = "0.45"; b.style.pointerEvents = "none";
  }
}
function hideBlocked() {
  if (els.blocked.hidden) return;
  els.blocked.hidden = true;
  for (const b of [els.export, els.import, els.clear]) {
    b.disabled = false; b.style.opacity = ""; b.style.pointerEvents = "";
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
  const currentRows = (u.rows || []).map((r) => ({ ...r, _path: u.path }));
  // Current page first.
  if (currentRows.length) {
    groups.push({ path: u.path, title: u.title, current: true, rows: currentRows });
  }
  // Other pages (alphabetical), from storage.
  for (const [path, pg] of Object.entries(storedPages).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (path === u.path) continue;
    const rows = (pg.changes || []).map((c) => ({
      id: null,
      status: "saved",
      original: c.original,
      edited: c.edited,
      element: c.element || {},
      _path: path,
    }));
    if (rows.length) groups.push({ path, title: pg.title, current: false, rows });
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

  els.list.innerHTML = "";
  for (const g of groups) els.list.appendChild(renderGroup(g));
}

function renderGroup(g) {
  const wrap = document.createElement("section");
  wrap.className = "group";

  const head = document.createElement("div");
  head.className = "group-head";
  const path = document.createElement("span");
  path.className = "group-path";
  path.textContent = g.path;
  if (g.title) path.title = g.title;
  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(g.rows.length);
  head.append(path, count);
  if (g.current) {
    const here = document.createElement("span");
    here.className = "group-here";
    here.textContent = "this page";
    head.appendChild(here);
  }
  wrap.appendChild(head);

  for (const r of g.rows) wrap.appendChild(renderRow(r, g.current));
  return wrap;
}

function renderRow(r, isCurrent) {
  const el = r.element || {};
  const row = document.createElement("div");
  row.className = "row" + (isCurrent ? "" : " offpage");

  const top = document.createElement("div");
  top.className = "top";

  if (r.status === "warning") {
    const badge = document.createElement("span");
    badge.className = "badge miss";
    badge.textContent = "needs attention";
    badge.title = "Saved edit couldn't be applied on this page (text changed or element gone).";
    top.appendChild(badge);
  } else if (isCurrent) {
    const badge = document.createElement("span");
    badge.className = "badge ok";
    badge.textContent = "applied";
    top.appendChild(badge);
  }

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = `<${el.tag || "?"}>` + (el.componentHint ? ` · ${el.componentHint}` : "");
  top.appendChild(tag);

  const action = document.createElement("button");
  action.className = "locate";
  if (isCurrent && r.id) {
    action.textContent = "Locate ↧";
    action.title = "Scroll to this change on the page";
    action.addEventListener("click", (e) => { e.stopPropagation(); sendToTab({ cmd: "locate", id: r.id }); });
    top.appendChild(action);
  } else if (!isCurrent) {
    action.textContent = "Go ↗";
    action.title = "Open this page and highlight the change";
    action.addEventListener("click", (e) => { e.stopPropagation(); gotoChange(r); });
    top.appendChild(action);
  }

  const remove = document.createElement("button");
  remove.className = "rowx";
  remove.textContent = "✕";
  remove.title = "Remove this change";
  remove.addEventListener("click", (e) => { e.stopPropagation(); removeChange(r, isCurrent); });
  top.appendChild(remove);

  row.appendChild(top);

  const mini = document.createElement("div");
  mini.className = "mini";
  mini.appendChild(diffNodes(r.original, r.edited));
  row.appendChild(mini);

  const sel = document.createElement("div");
  sel.className = "sel";
  sel.textContent = el.selector || el.domPath || "(no selector)";
  row.appendChild(sel);

  if (el.context && el.context.nearestHeading) {
    const ctx = document.createElement("div");
    ctx.className = "ctx";
    ctx.textContent = "under: " + el.context.nearestHeading;
    row.appendChild(ctx);
  }

  // Clicking an off-page row navigates to it.
  if (!isCurrent) row.addEventListener("click", () => gotoChange(r));
  return row;
}

// Navigate to another page in the session, then flash the matching change.
function gotoChange(r) {
  const origin = lastUpdate && lastUpdate.origin;
  if (!origin || targetTabId == null) return;
  pendingFlash = { path: r._path, original: r.original };
  try { chrome.tabs.update(targetTabId, { url: origin + r._path }); } catch {}
}

function maybeFlash() {
  if (!pendingFlash || !lastUpdate || lastUpdate.path !== pendingFlash.path) return;
  const hit = (lastUpdate.rows || []).find((x) => x.id != null && x.original === pendingFlash.original);
  if (hit) sendToTab({ cmd: "locate", id: hit.id });
  pendingFlash = null;
}

async function removeChange(r, isCurrent) {
  if (isCurrent) {
    // Current page: let the engine revert it (and re-persist).
    await sendToTab({ cmd: "remove", id: r.id, original: r.original, edited: r.edited });
    return;
  }
  // Other page: edit storage directly.
  const origin = lastUpdate && lastUpdate.origin;
  const sessions = await getSessions();
  const session = sessions[origin];
  if (!session || !session.pages || !session.pages[r._path]) return;
  const pg = session.pages[r._path];
  pg.changes = (pg.changes || []).filter((c) => !(c.original === r.original && c.edited === r.edited));
  if (!pg.changes.length) delete session.pages[r._path];
  sessions[origin] = session;
  await setSessions(sessions);
}

// ======================================================================
// Toasts
// ======================================================================
function toast(message, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " err" : "");
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ======================================================================
init();
