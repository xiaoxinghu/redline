// sidepanel.js — the Copy Edit UI, living in Chrome's Side Panel.
//
// The panel owns the toolbar + the live list of changes. It has no access to
// the page DOM, so it drives the in-page engine (content.js) over messaging:
//
//   panel → engine   chrome.tabs.sendMessage(tabId, { cmd, ... })
//   engine → panel   chrome.runtime.onMessage  { type: "ce:update" | "ce:gone" }
//
// On open (and whenever the active tab changes or reloads) the panel injects
// content.js into the active tab and asks it for state. Reloading the page
// (⌘R / Ctrl R) tears the engine down with the page and re-activates it fresh
// against the original text — which is how "reset all" works now.

"use strict";

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;
const isRestricted = (url) =>
  RESTRICTED.test(url || "") || /https:\/\/chrome\.google\.com\/webstore/.test(url || "");

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  modeEdit: $("mode-edit"),
  modeReview: $("mode-review"),
  share: $("share"),
  import: $("import"),
  banner: $("banner"),
  listHeader: $("list-header"),
  list: $("list"),
  empty: $("empty"),
  idle: $("idle"),
  blocked: $("blocked"),
  blockedMsg: $("blocked-msg"),
  start: $("start"),
  drop: $("drop"),
  toasts: $("toasts"),
  file: $("file"),
};

let myWindowId = null;
let targetTabId = null;
let active = false;            // is the engine running in the target tab?
let lastUpdate = null;         // most recent ce:update payload

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
  // Only react to the tab we're driving.
  if (sender.tab && targetTabId != null && sender.tab.id !== targetTabId) return;
  if (msg.type === "ce:update") {
    active = true;
    lastUpdate = msg;
    render();
  } else if (msg.type === "ce:gone") {
    active = false;
    lastUpdate = null;
    showState("idle");
  }
});

// ======================================================================
// Activation — inject the engine into the active tab, then sync state.
// ======================================================================
async function activate(tab) {
  if (!tab || tab.id == null) {
    showBlocked("No active tab to edit.");
    return;
  }
  if (isRestricted(tab.url)) {
    targetTabId = null;
    showBlocked("Copy Edit can't run on this page (restricted URL). Open a normal web page and try again.");
    return;
  }
  targetTabId = tab.id;
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
  const [tab] = await chrome.tabs.query(
    myWindowId != null ? { active: true, windowId: myWindowId } : { active: true, currentWindow: true }
  );
  activate(tab);
}

// Follow the active tab within this window.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (myWindowId != null && windowId !== myWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    activate(tab);
  } catch {}
});

// A reload / navigation of our tab re-activates the engine on the fresh page.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== targetTabId) return;
  if (myWindowId != null && tab.windowId !== myWindowId) return;
  if (info.status === "complete") activate(tab);
});

// ======================================================================
// Toolbar actions
// ======================================================================
els.modeEdit.addEventListener("click", () => setMode("edit"));
els.modeReview.addEventListener("click", () => setMode("review"));
els.share.addEventListener("click", doShare);
els.import.addEventListener("click", () => els.file.click());
els.start.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query(
    myWindowId != null ? { active: true, windowId: myWindowId } : { active: true, currentWindow: true }
  );
  activate(tab);
});

async function setMode(mode) {
  if (!active) return;
  await sendToTab({ cmd: "setMode", mode });
}

async function doShare() {
  if (!active) return toast("Open a page and make an edit first.", "err");
  const resp = await sendToTab({ cmd: "export" });
  if (!resp || !resp.ok) return toast("Nothing to share.", "err");
  if (!resp.count) return toast("No changes to share yet.");

  const json = JSON.stringify(resp.changeset, null, 2);
  const page = resp.changeset.page || {};
  const slug = (page.path || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "page";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}.${stamp}.copyedit.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  const n = resp.count;
  const noun = `${n} change${n === 1 ? "" : "s"}`;
  try {
    await navigator.clipboard.writeText(json);
    toast(`Shared ${noun} — file downloaded + copied to clipboard.`);
  } catch {
    toast(`Shared ${noun} — file downloaded.`);
  }
}

// ======================================================================
// Import — file picker, drag-and-drop, location-aware apply
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
  applyIncoming(data);
}

async function applyIncoming(data) {
  if (!active) return toast("Open a normal web page first.", "err");
  const resp = await sendToTab({ cmd: "import", data });
  if (!resp || !resp.ok) return toast((resp && resp.error) || "Couldn't apply that changeset.", "err");
  if (resp.needsOpen) showOpenBanner(resp.page || {});
  else hideBanner();
}

function showOpenBanner(page) {
  const where = page.url || page.path || "another page";
  els.banner.hidden = false;
  els.banner.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "banner-msg";
  msg.textContent = `This changeset is for ${where}.`;
  const open = document.createElement("button");
  open.textContent = "Open & apply";
  open.addEventListener("click", () => {
    if (page.url) {
      chrome.runtime.sendMessage({ type: "copyedit-open-and-apply", url: page.url }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) {
          try { chrome.tabs.create({ url: page.url }); } catch {}
        }
      });
    }
    hideBanner();
  });
  const x = document.createElement("span");
  x.className = "x";
  x.textContent = "✕";
  x.title = "Dismiss";
  x.addEventListener("click", hideBanner);
  els.banner.append(msg, open, x);
}
function hideBanner() {
  els.banner.hidden = true;
  els.banner.innerHTML = "";
}

// Drag a changeset file onto the panel.
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
function showState(which) {
  // which ∈ "active" | "idle" | "blocked" | null
  const showActive = which === "active";
  els.blocked.hidden = which !== "blocked";
  els.idle.hidden = which !== "idle";

  // Toolbar is only meaningful while active.
  const toolbarOff = which === "blocked" || which === "idle";
  for (const b of [els.modeEdit, els.modeReview, els.share, els.import]) {
    b.disabled = toolbarOff;
    b.style.opacity = toolbarOff ? "0.45" : "";
    b.style.pointerEvents = toolbarOff ? "none" : "";
  }
  if (toolbarOff) {
    els.list.hidden = true;
    els.listHeader.hidden = true;
    els.empty.hidden = true;
    hideBanner();
    if (which === "blocked") els.status.textContent = "blocked";
    if (which === "idle") els.status.textContent = "stopped";
  } else {
    els.list.hidden = false;
  }
}

function showBlocked(message) {
  els.blockedMsg.textContent = message;
  showState("blocked");
}
function hideBlocked() {
  if (!els.blocked.hidden) showState("active");
}

function render() {
  if (!active || !lastUpdate) return;
  showState("active");

  const u = lastUpdate;
  const rows = u.rows || [];

  // Status pill
  if (u.mode === "edit") {
    els.status.textContent = u.changeCount
      ? `editing · ${u.changeCount}`
      : "editing";
  } else {
    els.status.textContent = u.changeCount
      ? `${u.changeCount} change${u.changeCount === 1 ? "" : "s"}`
      : "review";
  }

  // Mode segmented control
  els.modeEdit.classList.toggle("is-active", u.mode === "edit");
  els.modeReview.classList.toggle("is-active", u.mode === "review");
  els.modeEdit.setAttribute("aria-selected", String(u.mode === "edit"));
  els.modeReview.setAttribute("aria-selected", String(u.mode === "review"));

  // Warning banner (page mismatch)
  if (u.warn) {
    els.banner.hidden = false;
    els.banner.innerHTML = "";
    const m = document.createElement("span");
    m.className = "banner-msg";
    m.textContent = "⚠︎ " + u.warn;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", hideBanner);
    els.banner.append(m, x);
  }

  // Empty vs list
  if (!rows.length) {
    els.list.hidden = true;
    els.listHeader.hidden = true;
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.list.hidden = false;
  els.listHeader.hidden = false;
  els.listHeader.textContent = u.header || `${rows.length} changes`;

  els.list.innerHTML = "";
  for (const r of rows) els.list.appendChild(renderRow(r));
}

function diffNodes(tokens) {
  const frag = document.createDocumentFragment();
  for (const t of tokens || []) {
    if (t.op === "=") frag.appendChild(document.createTextNode(t.text));
    else {
      const el = document.createElement(t.op === "+" ? "ins" : "del");
      el.textContent = t.text;
      frag.appendChild(el);
    }
  }
  return frag;
}

function renderRow(r) {
  const el = r.element || {};
  const row = document.createElement("div");
  row.className = "row";

  const top = document.createElement("div");
  top.className = "top";

  const badge = document.createElement("span");
  const matched = r.status !== "unmatched";
  badge.className = "badge " + (matched ? "ok" : "miss");
  badge.textContent = matched ? "applied" : "not found";
  top.appendChild(badge);

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = `<${el.tag || "?"}>` + (el.componentHint ? ` · ${el.componentHint}` : "");
  top.appendChild(tag);

  if (r.id) {
    const loc = document.createElement("button");
    loc.className = "locate";
    loc.textContent = "Locate ↧";
    loc.addEventListener("click", () => sendToTab({ cmd: "locate", id: r.id }));
    top.appendChild(loc);
  }
  row.appendChild(top);

  const mini = document.createElement("div");
  mini.className = "mini";
  mini.appendChild(diffNodes(r.diff));
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
  return row;
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
