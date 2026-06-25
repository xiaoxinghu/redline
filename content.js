// content.js — the in-page engine. Injected by the side panel (sidepanel.js)
// into the active tab. It owns everything that must touch the page DOM:
// snapshotting text, two-mode editing, the inline diff, applying imported
// changesets, and building the export changeset. It has NO visible UI of its
// own — the toolbar and change list live in the side panel, which drives this
// engine over messaging.
//
// MESSAGING
//   panel → engine   chrome.tabs.sendMessage(tabId, { cmd, ... })
//       getState | setMode | export | import | locate | teardown
//   engine → panel   chrome.runtime.sendMessage({ type: "ce:update", ... })
//       (live list of changes, current mode, page info)
//
// MODES
//   Edit   : document.designMode = "on" — edit text in place, no diff markup.
//   Review : editing off; each changed text run renders inline <ins>/<del>.
//
// Re-injecting this file while it's already active is a no-op: it just re-pushes
// the current state to the panel (so re-opening / tab-switching stays in sync).

(function () {
  "use strict";

  // Already active in this tab → just re-report state and bail (no re-snapshot).
  if (window.__copyEditTool) {
    try { window.__copyEditTool.pushUpdate(); } catch {}
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
  let unmatchedRows = [];         // "not found" rows from the last import
  let panelHeader = null;         // header override from the last import
  let panelWarn = null;           // page-mismatch warning from the last import

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

  /** Token diff (for the panel to render safely as DOM, not HTML). */
  function diffTokensFor(original, current) {
    return diffTokens(tokenize(original), tokenize(current));
  }

  function diffFragment(original, current) {
    const frag = document.createDocumentFragment();
    for (const p of diffTokensFor(original, current)) {
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
    return diffTokensFor(original, current).map((p) =>
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
    pushUpdate();
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
    pushUpdate();
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
        "To re-apply/visualise: open the same URL, open the Copy Edit side panel, and Import this file. " +
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
    const results = [];
    for (const change of data.changes || []) {
      const el = resolveElement(change);
      const span = findSpan(el, change);
      if (span) {
        span.textContent = change.edited;  // DOM is the source of truth in Edit mode
        results.push({ status: "matched", change, span });
      } else {
        results.push({ status: "unmatched", change, span: null });
      }
    }
    enterReview();
    const matched = results.filter((r) => r.status === "matched").length;
    // Remember the "not found" rows + headline so the panel can surface them.
    unmatchedRows = results
      .filter((r) => r.status === "unmatched")
      .map((r) => ({
        status: "unmatched",
        id: null,
        original: r.change.original,
        edited: r.change.edited,
        diff: diffTokensFor(r.change.original, r.change.edited),
        element: r.change.element || {},
      }));
    panelHeader = `Imported ${matched}/${results.length} changes`;
    panelWarn =
      data.page && data.page.path && data.page.path !== location.pathname
        ? `changeset was captured on "${data.page.path}" — you are on "${location.pathname}"`
        : null;
    pushUpdate();
  }

  // ======================================================================
  // 6. Receive a changeset + location-aware apply.
  // ======================================================================
  const PENDING_KEY = "copyedit_pending";

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

  /** Returns a response object for the panel (does not render anything). */
  function handleIncomingChangeset(data) {
    if (!data || data.format !== FORMAT) {
      return { ok: false, error: "That isn't a Copy Edit changeset." };
    }
    if (matchUrl(data.page)) {
      importChangeset(data);
      return { ok: true, applied: true };
    }
    // Different page → stash it; the panel offers "Open & apply", which asks the
    // background worker to open the target URL and inject the tool there, where
    // maybeApplyPending() re-applies the stashed changeset on boot (10 min TTL).
    storageSet({ [PENDING_KEY]: { data, ts: Date.now() } });
    return { ok: true, needsOpen: true, page: data.page || {} };
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
  // 7. Panel bridge — push the live change list to the side panel.
  // ======================================================================
  function send(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch {}
  }

  function buildRows() {
    const rows = changedIds().map((id) => ({
      status: "matched",
      id,
      original: originals.get(id),
      edited: currentText(id),
      diff: diffTokensFor(originals.get(id), currentText(id)),
      element: descriptors.get(id),
    }));
    return rows.concat(unmatchedRows);
  }

  function pushUpdate() {
    const changeCount = changedIds().length;
    const header =
      panelHeader || `${changeCount} change${changeCount === 1 ? "" : "s"} on this page`;
    send({
      type: "ce:update",
      mode: state.mode,
      changeCount,
      header,
      warn: panelWarn,
      page: { path: location.pathname, url: location.href, title: document.title },
      rows: buildRows(),
    });
  }

  function flash(id) {
    const span = spans.get(id);
    if (!span) return false;
    span.scrollIntoView({ behavior: "smooth", block: "center" });
    span.classList.add("ce-flash");
    setTimeout(() => span.classList.remove("ce-flash"), 1800);
    return true;
  }

  // Live updates: while editing, recompute the list as the user types.
  let pushTimer = null;
  function onInput() {
    if (state.mode !== "edit") return;
    // Editing a span clears its remembered import-diff association; if the user
    // edits after an import, drop the import headline so the live count shows.
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      panelHeader = null;
      pushUpdate();
    }, 250);
  }

  // ======================================================================
  // 8. Interaction neutralisation
  // ======================================================================
  // While the tool is active, neutralise the page's own click/navigation so the
  // editor can click on links/buttons just to place the caret and edit their
  // text. We intercept at the window capture phase and stop propagation. We
  // don't preventDefault on pointer/mouse-down (so caret placement + dblclick
  // word-select still work); we only cancel the default for activating events.
  function interceptInteractions() {
    const handler = (e) => {
      const t = e.target;
      if (t && t.closest && t.closest(`[${UI_ATTR}]`)) return;
      e.stopImmediatePropagation();
      if (e.type === "click" || e.type === "auxclick" || e.type === "submit") e.preventDefault();
    };
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick", "submit"];
    for (const ty of types) window.addEventListener(ty, handler, true);
    return { types, handler };
  }

  // ======================================================================
  // Page CSS + message listener + teardown + boot
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

  function onMessage(msg, sender, sendResponse) {
    if (!msg || !msg.cmd) return;
    switch (msg.cmd) {
      case "getState":
        pushUpdate();
        sendResponse({ ok: true, mode: state.mode });
        break;
      case "setMode":
        if (msg.mode === "review") enterReview();
        else enterEdit();
        sendResponse({ ok: true, mode: state.mode });
        break;
      case "export": {
        const cs = buildChangeset();
        sendResponse({ ok: true, changeset: cs, count: (cs.changes || []).length });
        break;
      }
      case "import":
        sendResponse(handleIncomingChangeset(msg.data));
        break;
      case "locate":
        sendResponse({ ok: flash(msg.id) });
        break;
      case "teardown":
        teardown();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown cmd" });
    }
    // All branches respond synchronously.
  }

  let listeners = null;
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
    if (listeners) {
      for (const ty of listeners.intercept.types) {
        window.removeEventListener(ty, listeners.intercept.handler, true);
      }
      document.removeEventListener("input", onInput, true);
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    }
    pageStyle && pageStyle.remove();
    delete window.__copyEditTool;
    send({ type: "ce:gone" });
  }

  try {
    snapshot();
    pageStyle = injectPageStyle();
    const intercept = interceptInteractions();
    document.addEventListener("input", onInput, true);
    chrome.runtime.onMessage.addListener(onMessage);
    listeners = { intercept };
    enterEdit();
    window.__copyEditTool = { teardown, applyChangeset: handleIncomingChangeset, pushUpdate };
    maybeApplyPending();
  } catch (err) {
    console.error("[Copy Edit] failed to start:", err);
    teardown();
  }
})();
