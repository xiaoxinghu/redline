// content.js — injected on toolbar click.
//
// WORKFLOW
//   Business person:  click icon → edit text in place → Export → .copyedit.json
//   Developer:        open same page → click icon → Import the .copyedit.json
//                     → changes are re-applied + shown as an inline diff, with a
//                     panel listing each change, its selector, and a "Locate"
//                     button. The JSON itself is built to be read by a coding
//                     agent (exact original strings + element identity + context).
//
// MODES
//   Edit   : document.designMode = "on" — edit text in place, no diff markup.
//   Review : editing off; each changed text run renders inline <ins>/<del>.
//
// Re-running this file (re-clicking the toolbar icon) toggles the tool OFF.

(function () {
  "use strict";

  if (window.__copyEditTool) {
    window.__copyEditTool.teardown();
    return;
  }

  const UI_ATTR = "data-ce-ui";
  const ID_ATTR = "data-ce-id";
  const FORMAT = "copy-edit-changeset";
  const FORMAT_VERSION = 1;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS",
  ]);

  const originals = new Map();   // id -> original text (fixed at snapshot)
  const currents = new Map();    // id -> current edited text
  const spans = new Map();       // id -> wrapper <span>
  const descriptors = new Map(); // id -> element identity (computed pristine)

  const state = { mode: "edit" };
  let idCounter = 0;

  // ======================================================================
  // Element identity helpers (computed on the PRISTINE DOM, pre-wrapping)
  // ======================================================================
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function domPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function collectAttrs(el) {
    const keep = ["role", "name", "type", "href", "alt", "title", "placeholder", "for"];
    const out = {};
    for (const k of keep) if (el.hasAttribute(k)) out[k] = el.getAttribute(k);
    for (const a of el.attributes) {
      if (a.name.startsWith("aria-") || a.name.startsWith("data-")) out[a.name] = a.value;
    }
    return out;
  }

  /** Best-effort React component name from data-* or CSS-module class names. */
  function componentHint(el) {
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 4; i++, node = node.parentElement) {
      if (node.dataset && node.dataset.component) return node.dataset.component;
      if (node.dataset && node.dataset.testid) return node.dataset.testid;
    }
    node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 4; i++, node = node.parentElement) {
      for (const c of node.classList) {
        const m = c.match(/^([A-Za-z][A-Za-z0-9]*)(?:[_-]|$)/);
        if (m && /^[A-Z]/.test(m[1])) return m[1]; // e.g. Hero_tagline__x7f2 → "Hero"
      }
    }
    return null;
  }

  let allHeadings = [];
  function nearestHeading(el) {
    let best = null;
    for (const h of allHeadings) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
      else break;
    }
    return best ? best.textContent.trim().replace(/\s+/g, " ") : null;
  }

  function nearestLandmark(el) {
    const lm = el.closest("nav, main, header, footer, aside, section, form, article, [role]");
    if (!lm) return null;
    return lm.getAttribute("aria-label") || lm.getAttribute("role") || lm.tagName.toLowerCase();
  }

  /** Index of textNode among its parent's qualifying (non-whitespace) child text nodes. */
  function qualifyingTextIndex(textNode) {
    let idx = 0;
    for (const child of textNode.parentNode.childNodes) {
      if (child === textNode) return idx;
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue && child.nodeValue.trim()) idx++;
    }
    return idx;
  }

  function describe(textNode) {
    const el = textNode.parentElement;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList],
      componentHint: componentHint(el),
      attributes: collectAttrs(el),
      selector: cssPath(el),
      domPath: domPath(el),
      elementText: (el.textContent || "").trim().replace(/\s+/g, " "),
      textIndex: qualifyingTextIndex(textNode),
      context: { nearestHeading: nearestHeading(el), landmark: nearestLandmark(el) },
    };
  }

  // ======================================================================
  // 1. Snapshot  (collect → describe pristine → wrap)
  // ======================================================================
  function snapshot() {
    allHeadings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`[${UI_ATTR}]`)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    // Describe everything BEFORE mutating the DOM, so paths/indices are pristine.
    const described = textNodes.map((tn) => [tn, describe(tn)]);

    for (const [tn, desc] of described) {
      const id = "ce-" + idCounter++;
      const span = document.createElement("span");
      span.setAttribute(ID_ATTR, id);
      span.className = "ce-track";
      span.textContent = tn.nodeValue;
      originals.set(id, tn.nodeValue);
      descriptors.set(id, desc);
      spans.set(id, span);
      tn.parentNode.replaceChild(span, tn);
    }
  }

  // ======================================================================
  // 2. Diff  (dependency-free word/whitespace token LCS)
  // ======================================================================
  function tokenize(s) {
    return s.match(/(\s+|[^\s]+)/g) || [];
  }

  function diffTokens(a, b) {
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

  function diffFragment(original, current) {
    const frag = document.createDocumentFragment();
    for (const p of diffTokens(tokenize(original), tokenize(current))) {
      if (p.op === "=") frag.appendChild(document.createTextNode(p.text));
      else {
        const el = document.createElement(p.op === "+" ? "ins" : "del");
        el.className = p.op === "+" ? "ce-ins" : "ce-del";
        el.textContent = p.text;
        frag.appendChild(el);
      }
    }
    return frag;
  }

  function diffPreview(original, current) {
    return diffTokens(tokenize(original), tokenize(current)).map((p) =>
      p.op === "=" ? p.text : p.op === "+" ? `[+${p.text}]` : `[-${p.text}]`
    ).join("");
  }

  // ======================================================================
  // 3. Modes
  // ======================================================================
  // The current text of a span depends on the mode: in Edit mode the live
  // DOM text is authoritative; in Review mode the span holds diff markup, so
  // the text captured when we entered Review (`currents`) is authoritative.
  function currentText(id) {
    if (state.mode === "review") return currents.has(id) ? currents.get(id) : originals.get(id);
    const span = spans.get(id);
    return span ? span.textContent : originals.get(id);
  }

  function changedIds() {
    const ids = [];
    for (const [id, original] of originals) {
      if (currentText(id) !== original) ids.push(id);
    }
    return ids;
  }

  function enterEdit() {
    for (const [id, span] of spans) {
      if (currents.has(id)) span.textContent = currents.get(id);
    }
    document.designMode = "on";
    document.documentElement.classList.remove("ce-review-mode");
    state.mode = "edit";
    refreshUI();
  }

  function enterReview() {
    document.designMode = "off";
    for (const [id, span] of spans) {
      const current = span.textContent;   // Edit mode keeps the live text here
      currents.set(id, current);          // always re-capture (fixes lost re-edits)
      const original = originals.get(id);
      span.textContent = "";
      if (current === original) span.textContent = current;
      else span.appendChild(diffFragment(original, current));
    }
    document.documentElement.classList.add("ce-review-mode");
    state.mode = "review";
    refreshUI();
  }

  function resetAll() {
    if (!confirm("Discard all edits and restore the original page text?")) return;
    for (const [id, span] of spans) {
      currents.set(id, originals.get(id));
      span.textContent = originals.get(id);
    }
    enterEdit();
  }

  // ======================================================================
  // 4. Export changeset (the developer-facing data file)
  // ======================================================================
  function buildChangeset() {
    const ids = changedIds();
    const changes = ids.map((id, i) => {
      const original = originals.get(id);
      const edited = currentText(id);
      return {
        index: i + 1,
        original,
        edited,
        diffPreview: diffPreview(original, edited),
        element: descriptors.get(id),
      };
    });

    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      readme:
        "Copy-edit changeset. Each entry is a text change a content editor made on the live page. " +
        "To re-apply/visualise: open the same URL, run the Copy Edit extension, and Import this file. " +
        "To locate in source code: search the codebase for the exact `original` string. " +
        "`element.selector`/`element.domPath` give the DOM location; `element.id`, `element.classes`, " +
        "`element.componentHint`, `element.attributes` (incl. data-testid/data-component) and " +
        "`element.context.nearestHeading` help identify the React component that renders it.",
      page: {
        url: location.href,
        origin: location.origin,
        path: location.pathname,
        title: document.title,
        lang: document.documentElement.lang || null,
        viewport: { width: innerWidth, height: innerHeight },
        capturedAt: new Date().toISOString(),
      },
      summary: {
        changeCount: changes.length,
        distinctOriginals: [...new Set(changes.map((c) => c.original))],
      },
      changes,
    };
  }

  function exportChangeset() {
    const data = buildChangeset();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug = (location.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "page");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `${slug}.${stamp}.copyedit.json`;
    a.setAttribute(UI_ATTR, "");
    document.documentElement.appendChild(a);

    // In Edit mode designMode is "on", which makes the document editable and
    // causes the browser to swallow anchor activation (so the download click
    // does nothing). Toggle designMode off just for the click, then restore.
    const wasEditing = document.designMode === "on";
    if (wasEditing) document.designMode = "off";
    a.click();
    if (wasEditing) document.designMode = "on";

    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    // Also copy to clipboard so the editor can paste it into email/Slack.
    const n = (data.changes || []).length;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json)
        .then(() => toast(`Exported ${n} change${n === 1 ? "" : "s"} — file downloaded + copied to clipboard.`))
        .catch(() => toast(`Exported ${n} change${n === 1 ? "" : "s"} — file downloaded.`));
    } else {
      toast(`Exported ${n} change${n === 1 ? "" : "s"} — file downloaded.`);
    }
  }

  // ======================================================================
  // 5. Import changeset (developer side: re-apply + visualise)
  // ======================================================================
  function safeQueryAll(sel) {
    if (!sel) return [];
    try { return [...document.querySelectorAll(sel)]; } catch { return []; }
  }

  function resolveElement(change) {
    const el = change.element || {};
    let m = safeQueryAll(el.selector);
    if (m.length === 1) return m[0];
    const byPath = safeQueryAll(el.domPath);
    if (byPath.length === 1) return byPath[0];
    if (m.length > 1) return m[0]; // ambiguous → first
    return null;
  }

  function findSpan(el, change) {
    const ti = change.element?.textIndex ?? 0;
    if (el) {
      const direct = [...el.children].filter((c) => c.matches?.("span.ce-track"));
      const hit = direct[ti];
      if (hit && originals.get(hit.getAttribute(ID_ATTR)) === change.original) return hit;
      for (const s of el.querySelectorAll("span.ce-track")) {
        if (originals.get(s.getAttribute(ID_ATTR)) === change.original) return s;
      }
    }
    // last resort: unique original text anywhere on the page
    let found = null, count = 0;
    for (const s of spans.values()) {
      if (originals.get(s.getAttribute(ID_ATTR)) === change.original) { found = s; count++; }
    }
    return count === 1 ? found : null;
  }

  function importChangeset(data) {
    if (state.mode === "review") enterEdit();
    const rows = [];
    for (const change of data.changes || []) {
      const el = resolveElement(change);
      const span = findSpan(el, change);
      if (span) {
        span.textContent = change.edited;  // DOM is the source of truth in Edit mode
        rows.push({ status: "matched", change, span });
      } else {
        rows.push({ status: "unmatched", change, span: null });
      }
    }
    enterReview();
    const matched = rows.filter((r) => r.status === "matched").length;
    const pageWarn = data.page && data.page.path && data.page.path !== location.pathname
      ? `⚠︎ changeset was captured on "${data.page.path}" — you are on "${location.pathname}"`
      : null;
    renderPanel(rows, `Imported ${matched}/${rows.length} changes`, pageWarn);
  }

  // ======================================================================
  // 6. Receive a changeset (file drop / picker / clipboard) + location-aware
  //    apply. All reads use the File/Clipboard APIs — no extra permissions.
  // ======================================================================
  const PENDING_KEY = "copyedit_pending";

  function parseChangeset(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function matchUrl(page) {
    if (!page) return false;
    if (page.origin && page.origin !== location.origin) return false;
    if (page.path) return page.path === location.pathname;
    return true;
  }

  function storageSet(obj) {
    return new Promise((res) => { try { chrome.storage.local.set(obj, res); } catch { res(); } });
  }
  function storageGet(key) {
    return new Promise((res) => { try { chrome.storage.local.get(key, (r) => res(r || {})); } catch { res({}); } });
  }
  function storageRemove(key) { try { chrome.storage.local.remove(key); } catch {} }

  function handleIncomingChangeset(data) {
    if (!data || data.format !== FORMAT) { toast("That isn't a Copy Edit changeset.", "err"); return; }
    if (matchUrl(data.page)) {
      importChangeset(data);
      return;
    }
    // Different page → stash it and offer to open the right URL. The
    // background worker opens the tab AND injects the tool, which auto-applies
    // the stashed changeset on boot (valid for 10 minutes).
    storageSet({ [PENDING_KEY]: { data, ts: Date.now() } });
    const page = data.page || {};
    const where = page.url || page.path || "another page";
    toast(`This changeset is for ${where}.`, null, {
      label: "Open & apply",
      fn: () => {
        const fallback = () => {
          // Background didn't handle it (e.g. extension not reloaded after an
          // update). Open the tab; the user activates the tool manually there.
          try { window.open(page.url, "_blank"); } catch {}
          toast("Opened it — click the Copy Edit icon on that tab to apply.");
        };
        try {
          if (page.url && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage(
              { type: "copyedit-open-and-apply", url: page.url },
              (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) fallback();
                else toast("Opening it and applying your changes…");
              }
            );
            return;
          }
        } catch {}
        fallback();
      },
    });
  }

  async function maybeApplyPending() {
    const r = await storageGet(PENDING_KEY);
    const pending = r[PENDING_KEY];
    if (!pending || !pending.data) return;
    if (Date.now() - (pending.ts || 0) > 10 * 60 * 1000) { storageRemove(PENDING_KEY); return; }
    if (matchUrl(pending.data.page)) {
      storageRemove(PENDING_KEY);
      importChangeset(pending.data);
    }
  }

  // ======================================================================
  // UI
  // ======================================================================
  let ui = {};

  function buildUI() {
    const host = document.createElement("div");
    host.setAttribute(UI_ATTR, "");
    host.setAttribute("contenteditable", "false");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          position: fixed; top: 12px; right: 12px; z-index: 2147483647;
          display: flex; align-items: center; gap: 6px;
          background: #1f2330; color: #fff; padding: 8px 10px; border-radius: 10px;
          font: 13px/1 -apple-system, Segoe UI, Roboto, sans-serif;
          box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: calc(100vw - 24px);
        }
        .title { font-weight: 700; margin-right: 4px; }
        .seg { display: flex; background: #333a4d; border-radius: 7px; overflow: hidden; }
        button { all: unset; cursor: pointer; padding: 6px 9px; color: #cfd4e0; font: inherit; border-radius: 6px; }
        button:hover { color: #fff; }
        .seg button.active { background: #4c7dff; color: #fff; }
        .act { background: #333a4d; } .act:hover { background: #424b63; color: #fff; }
        .status { color: #9aa3b8; min-width: 72px; text-align: right; }
        .exit { color: #ff9a9a; }
        .panel {
          position: fixed; top: 58px; right: 12px; z-index: 2147483647;
          width: 380px; max-width: calc(100vw - 24px); max-height: 70vh; overflow: auto;
          background: #fff; color: #1a1a1a; border-radius: 10px; display: none;
          box-shadow: 0 10px 40px rgba(0,0,0,.3);
          font: 12.5px/1.5 -apple-system, Segoe UI, Roboto, sans-serif;
        }
        .panel.show { display: block; }
        .phead { position: sticky; top: 0; background: #f4f6fb; padding: 9px 12px; font-weight: 700;
                 border-bottom: 1px solid #e3e7f0; display: flex; justify-content: space-between; }
        .pwarn { background: #fff5d6; color: #6b5400; padding: 7px 12px; border-bottom: 1px solid #f0e3a9; }
        .row { padding: 9px 12px; border-bottom: 1px solid #eef0f5; }
        .row .top { display: flex; align-items: center; gap: 6px; }
        .badge { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 99px; }
        .ok { background: #d7f5dd; color: #1c6b34; } .miss { background: #ffd9d9; color: #8a1f1f; }
        .sel { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #555;
               word-break: break-all; margin: 3px 0; }
        .ctx { color: #888; font-size: 11px; }
        .mini ins { background: #d7f5dd; text-decoration: none; }
        .mini del { background: #ffd9d9; }
        .loc { all: unset; cursor: pointer; color: #4c7dff; font-weight: 600; margin-left: auto; }
        .drop { position: fixed; inset: 0; z-index: 2147483646; display: none; align-items: center; justify-content: center; background: rgba(20,24,40,.55); }
        .drop.show { display: flex; }
        .dropbox { padding: 28px 40px; border: 3px dashed #9bb4ff; border-radius: 16px; background: #1f2330; color: #fff;
                   font: 600 18px/1.4 -apple-system, Segoe UI, Roboto, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
        .paste { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; background: rgba(20,24,40,.45); }
        .paste.show { display: flex; }
        .pbox { width: min(560px, 92vw); background: #fff; color: #1a1a1a; border-radius: 12px; padding: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,.35); font: 13px -apple-system, Segoe UI, Roboto, sans-serif; }
        .phd { font-weight: 700; margin-bottom: 8px; }
        .pbox textarea { width: 100%; height: 220px; box-sizing: border-box; font-family: ui-monospace, Menlo, monospace;
                         font-size: 12px; border: 1px solid #ccd2e0; border-radius: 8px; padding: 8px; resize: vertical; }
        .prow { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
        .pbtn { background: #4c7dff; color: #fff; padding: 7px 14px; border-radius: 7px; }
        .pbtn.ghost { background: #e8ebf2; color: #333; }
        .toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
                  display: flex; flex-direction: column; gap: 8px; align-items: center; }
        .toast { background: #1f2330; color: #fff; padding: 10px 14px; border-radius: 8px; display: flex; align-items: center; gap: 10px;
                 font: 13px -apple-system, Segoe UI, Roboto, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); max-width: 80vw; }
        .toast.err { background: #7a2230; }
        .toast button { background: #4c7dff; color: #fff; padding: 5px 10px; border-radius: 6px; cursor: pointer; }
      </style>
      <div class="bar">
        <span class="title">Copy&nbsp;Edit</span>
        <span class="seg">
          <button id="edit" class="active">✏️ Edit</button>
          <button id="review">🔍 Review</button>
        </span>
        <span class="status" id="status">editing…</span>
        <button id="list" class="act">☰ Changes</button>
        <button id="export" class="act">⬇︎ Export</button>
        <button id="import" class="act">⬆︎ Import</button>
        <button id="paste" class="act">📋 Paste</button>
        <button id="reset" class="act">↺ Reset</button>
        <button id="exit" class="exit">✕</button>
      </div>
      <div class="panel" id="panel"></div>
      <div class="drop" id="drop"><div class="dropbox">Drop a <u>.copyedit.json</u> changeset to apply</div></div>
      <div class="paste" id="pastePanel">
        <div class="pbox">
          <div class="phd">Paste changeset JSON</div>
          <textarea id="pasteText" placeholder="Paste the changeset here (Cmd/Ctrl+V), then Apply"></textarea>
          <div class="prow">
            <button id="pasteCancel" class="pbtn ghost">Cancel</button>
            <button id="pasteApply" class="pbtn">Apply</button>
          </div>
        </div>
      </div>
      <div class="toasts" id="toasts"></div>`;
    document.documentElement.appendChild(host);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.setAttribute(UI_ATTR, "");
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const data = parseChangeset(await f.text());
      if (!data) toast("Could not read that file as JSON.", "err");
      else handleIncomingChangeset(data);
      fileInput.value = "";
    });
    document.documentElement.appendChild(fileInput);

    const $ = (id) => shadow.getElementById(id);
    ui = { host, shadow, fileInput, edit: $("edit"), review: $("review"), status: $("status"), panel: $("panel"),
           drop: $("drop"), pastePanel: $("pastePanel") };

    $("edit").addEventListener("click", () => state.mode !== "edit" && enterEdit());
    $("review").addEventListener("click", () => state.mode !== "review" && enterReview());
    $("list").addEventListener("click", toggleList);
    $("export").addEventListener("click", exportChangeset);
    $("import").addEventListener("click", () => fileInput.click());
    $("paste").addEventListener("click", openPaste);
    $("pasteApply").addEventListener("click", applyPaste);
    $("pasteCancel").addEventListener("click", closePaste);
    $("reset").addEventListener("click", resetAll);
    $("exit").addEventListener("click", teardown);
  }

  function toggleList() {
    if (ui.panel.classList.contains("show")) { ui.panel.classList.remove("show"); return; }
    const rows = changedIds().map((id) => ({
      status: "matched",
      span: spans.get(id),
      change: {
        original: originals.get(id),
        edited: currentText(id),
        element: descriptors.get(id),
      },
    }));
    renderPanel(rows, `${rows.length} change${rows.length === 1 ? "" : "s"} on this page`, null);
  }

  function renderPanel(rows, headerText, warnText) {
    const p = ui.panel;
    p.textContent = "";
    const head = document.createElement("div");
    head.className = "phead";
    head.innerHTML = `<span></span><span style="cursor:pointer" id="pclose">✕</span>`;
    head.firstChild.textContent = headerText;
    p.appendChild(head);
    head.querySelector("#pclose").addEventListener("click", () => p.classList.remove("show"));

    if (warnText) {
      const w = document.createElement("div");
      w.className = "pwarn";
      w.textContent = warnText;
      p.appendChild(w);
    }

    for (const r of rows) {
      const el = r.change.element || {};
      const row = document.createElement("div");
      row.className = "row";

      const top = document.createElement("div");
      top.className = "top";
      const badge = document.createElement("span");
      badge.className = "badge " + (r.status === "matched" ? "ok" : "miss");
      badge.textContent = r.status === "matched" ? "applied" : "not found";
      top.appendChild(badge);
      const tag = document.createElement("span");
      tag.style.color = "#444";
      tag.textContent = `<${el.tag || "?"}>` + (el.componentHint ? ` · ${el.componentHint}` : "");
      top.appendChild(tag);
      if (r.span) {
        const loc = document.createElement("button");
        loc.className = "loc";
        loc.textContent = "Locate ↧";
        loc.addEventListener("click", () => flash(r.span));
        top.appendChild(loc);
      }
      row.appendChild(top);

      const mini = document.createElement("div");
      mini.className = "mini";
      mini.appendChild(diffFragment(r.change.original, r.change.edited));
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
      p.appendChild(row);
    }
    p.classList.add("show");
  }

  function flash(span) {
    span.scrollIntoView({ behavior: "smooth", block: "center" });
    span.classList.add("ce-flash");
    setTimeout(() => span.classList.remove("ce-flash"), 1800);
  }

  // ---- toast / drop / paste ----------------------------------------------
  function toast(msg, kind, action) {
    const box = ui.shadow && ui.shadow.getElementById("toasts");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "toast" + (kind === "err" ? " err" : "");
    const span = document.createElement("span");
    span.textContent = msg;
    el.appendChild(span);
    if (action) {
      const b = document.createElement("button");
      b.textContent = action.label;
      b.addEventListener("click", () => { action.fn(); el.remove(); });
      el.appendChild(b);
    }
    box.appendChild(el);
    setTimeout(() => el.remove(), action ? 12000 : 5000);
  }

  function showDrop(on) { ui.drop && ui.drop.classList.toggle("show", on); }

  function openPaste() {
    const t = ui.shadow.getElementById("pasteText");
    t.value = "";
    ui.pastePanel.classList.add("show");
    t.focus();
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((txt) => { if (txt && !t.value) t.value = txt; }).catch(() => {});
    }
  }
  function closePaste() { ui.pastePanel.classList.remove("show"); }
  function applyPaste() {
    const d = parseChangeset(ui.shadow.getElementById("pasteText").value.trim());
    if (!d) { toast("That isn't valid changeset JSON.", "err"); return; }
    closePaste();
    handleIncomingChangeset(d);
  }

  function registerDragAndDrop() {
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const over = (e) => { if (hasFiles(e)) { e.preventDefault(); showDrop(true); } };
    const leave = (e) => { if (e.relatedTarget === null) showDrop(false); };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      showDrop(false);
      const f = e.dataTransfer.files[0];
      f.text().then((t) => {
        const d = parseChangeset(t);
        if (!d) toast("That file isn't valid JSON.", "err");
        else handleIncomingChangeset(d);
      });
    };
    const end = () => showDrop(false);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end, true);
    ui.dragHandlers = { over, leave, drop, end };
  }

  // While the tool is active, neutralise the page's own click/navigation so the
  // editor can click on links/buttons just to place the caret and edit their
  // text. We intercept at the window capture phase (before the page or its
  // framework sees the event) and stop propagation. We deliberately DON'T
  // preventDefault on pointer/mouse-down so the browser still places the caret
  // and word-selects on double-click; we only cancel the default for the
  // activating events (click / auxclick / submit) to block navigation.
  function interceptInteractions() {
    const handler = (e) => {
      const t = e.target;
      if (t && t.closest && t.closest(`[${UI_ATTR}]`)) return; // our own UI keeps working
      e.stopImmediatePropagation();
      if (e.type === "click" || e.type === "auxclick" || e.type === "submit") e.preventDefault();
    };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick", "submit"];
    for (const ty of types) window.addEventListener(ty, handler, true);
    ui.intercept = { types, handler };
  }

  function refreshUI() {
    if (!ui.edit) return;
    ui.edit.classList.toggle("active", state.mode === "edit");
    ui.review.classList.toggle("active", state.mode === "review");
    if (state.mode === "edit") ui.status.textContent = "editing…";
    else {
      const n = changedIds().length;
      ui.status.textContent = n === 0 ? "no changes" : `${n} change${n === 1 ? "" : "s"}`;
    }
  }

  // ======================================================================
  // Page CSS + teardown + boot
  // ======================================================================
  let pageStyle = null;
  function injectPageStyle() {
    const style = document.createElement("style");
    style.setAttribute(UI_ATTR, "");
    style.textContent = `
      .ce-review-mode .ce-track ins.ce-ins { background:#d7f5dd; text-decoration:none; border-radius:2px; box-shadow:0 0 0 1px #9ad8aa inset; }
      .ce-review-mode .ce-track del.ce-del { background:#ffd9d9; border-radius:2px; box-shadow:0 0 0 1px #f0a9a9 inset; }
      .ce-track.ce-flash { animation: ce-flash-kf 1.8s ease; }
      @keyframes ce-flash-kf { 0%,100%{ box-shadow:none; } 15%,60%{ box-shadow:0 0 0 3px #ffd54a, 0 0 12px 4px #ffd54a; background:#fff7d1; } }
    `;
    document.head.appendChild(style);
    return style;
  }

  function teardown() {
    if (state.mode === "review") {
      for (const [id, span] of spans) if (currents.has(id)) span.textContent = currents.get(id);
    }
    document.designMode = "off";
    document.documentElement.classList.remove("ce-review-mode");
    for (const span of spans.values()) {
      const text = document.createTextNode(span.textContent);
      span.parentNode && span.parentNode.replaceChild(text, span);
    }
    spans.clear(); originals.clear(); currents.clear(); descriptors.clear();
    if (ui.dragHandlers) {
      window.removeEventListener("dragover", ui.dragHandlers.over, true);
      window.removeEventListener("dragleave", ui.dragHandlers.leave, true);
      window.removeEventListener("drop", ui.dragHandlers.drop, true);
      window.removeEventListener("dragend", ui.dragHandlers.end, true);
    }
    if (ui.intercept) {
      for (const ty of ui.intercept.types) window.removeEventListener(ty, ui.intercept.handler, true);
    }
    ui.host && ui.host.remove();
    ui.fileInput && ui.fileInput.remove();
    pageStyle && pageStyle.remove();
    delete window.__copyEditTool;
  }

  try {
    snapshot();
    pageStyle = injectPageStyle();
    buildUI();
    registerDragAndDrop();
    interceptInteractions();
    enterEdit();
    window.__copyEditTool = { teardown, applyChangeset: handleIncomingChangeset };
    maybeApplyPending();
  } catch (err) {
    console.error("[Copy Edit] failed to start:", err);
    teardown();
  }
})();
