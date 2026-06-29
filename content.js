// content.js — the in-page engine. Injected by the side panel (sidepanel.js)
// into the active tab. It owns everything that must touch the page DOM:
// snapshotting pristine text, the three view modes, applying a saved session's
// edits, and persisting this page's edits back to storage. Its only visible UI
// is a small floating mode toggle pinned to the corner of the page — two
// buttons that switch between the three modes (see "Floating control" below).
// The cross-page change list lives in the side panel, which drives this engine
// over messaging.
//
// SESSIONS (per origin, persisted in chrome.storage.local under copyedit_sessions)
//   { "<origin>": { mode, pages: { "<pathname>": { title, url, updatedAt,
//                                                   changes:[{element,original,edited}] } } } }
//   On boot we snapshot the pristine page, then re-apply this page's saved
//   changes. Edits made here are written back (debounced). Closing the panel
//   tears the engine down and restores the pristine page — the session stays in
//   storage and re-applies next time.
//
// MODES (persisted per origin)
//   edit    : designMode on  + clicks intercepted — type in place, plain text.
//   preview : designMode off + clicks live        — edits applied, site usable.
//   diff    : designMode off + clicks intercepted — inline <ins>/<del> overlay.
//   ("stopped" isn't a mode — it's simply the panel being closed.)
//
// MESSAGING
//   panel → engine   chrome.tabs.sendMessage(tabId, { cmd, ... })
//       getState | setMode | locate | remove | reset | teardown
//   engine → panel   chrome.runtime.sendMessage({ type: "ce:update" | "ce:gone", ... })

(function () {
  "use strict";

  // Already active in this tab → just re-report state and bail (no re-snapshot).
  if (window.__copyEditTool) {
    try { window.__copyEditTool.pushUpdate(); } catch {}
    return;
  }

  const UI_ATTR = "data-ce-ui";
  const ID_ATTR = "data-ce-id";
  const IMG_ID_ATTR = "data-ce-img-id";
  const SESSIONS_KEY = "copyedit_sessions";
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS",
  ]);

  const ORIGIN = location.origin;
  let PATH = location.pathname;  // mutable: same-document (SPA) nav re-points it

  const originals = new Map();   // id -> pristine text (fixed at snapshot)
  const currents = new Map();    // id -> edited text we want to show
  const spans = new Map();       // id -> wrapper <span>
  const descriptors = new Map(); // id -> element identity (computed pristine)
  let orphans = [];              // saved changes that couldn't be applied here
  let savedChanges = [];         // this page's saved edits, for re-applying to late content

  // Image replacement registry (parallel to the text maps above). Images are
  // mutated in place rather than wrapped, so we track them by their own id.
  const imgEls = new Map();        // id -> <img>
  const imgOriginals = new Map();  // id -> { src, srcset, sizes, alt } (pristine)
  const imgCurrents = new Map();   // id -> { dataUrl, fileName, fileType } (replacement)
  const imgDescriptors = new Map();// id -> element identity (computed pristine)
  const imgBlocked = new Set();    // ids whose preview the page's CSP refused

  let mode = "edit";             // edit | preview | diff
  let preDiffMode = "edit";       // mode to return to when the Diff switch is off
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
    const keep = ["role", "name", "type", "href", "src", "srcset", "alt", "title", "placeholder", "for"];
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

  /** Identity descriptor for a whole element (used for images, which aren't wrapped). */
  function describeElement(el) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList],
      componentHint: componentHint(el),
      attributes: collectAttrs(el),
      selector: cssPath(el),
      domPath: domPath(el),
      elementText: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
      context: { nearestHeading: nearestHeading(el), landmark: nearestLandmark(el) },
    };
  }

  // ======================================================================
  // 1. Snapshot  (collect → describe pristine → wrap)
  //
  // Idempotent: it only wraps text nodes that aren't already tracked, so it can
  // be re-run to pick up content the page renders late (hydration) or swaps in
  // on a same-document navigation, without disturbing existing wrappers.
  // ======================================================================
  function snapshot() {
    allHeadings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    snapshotImages();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`[${UI_ATTR}]`)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".ce-track")) return NodeFilter.FILTER_REJECT; // already tracked
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
      currents.set(id, tn.nodeValue);
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

  // ======================================================================
  // 3. Storage (per-origin sessions)
  // ======================================================================
  function storageGet(key) {
    return new Promise((res) => { try { chrome.storage.local.get(key, (r) => res(r || {})); } catch { res({}); } });
  }
  function storageSet(obj) {
    return new Promise((res) => { try { chrome.storage.local.set(obj, res); } catch { res(); } });
  }
  async function getSessions() {
    const r = await storageGet(SESSIONS_KEY);
    return r[SESSIONS_KEY] || {};
  }

  // Write this page's current edits (plus any unresolved saved edits) back into
  // the origin's session, and remember the current mode for next time.
  async function persist() {
    // Capture page identity + edits synchronously: a same-document (SPA)
    // navigation can change PATH/location/title before the awaited write below,
    // which would otherwise file these edits under the wrong page.
    const path = PATH;
    const title = document.title;
    const url = location.href.split("#")[0];
    const changes = buildPageChanges();
    const sessions = await getSessions();
    const session = sessions[ORIGIN] || { mode, pages: {} };
    session.mode = mode;
    if (changes.length) {
      session.pages[path] = { title, url, updatedAt: Date.now(), changes };
    } else {
      delete session.pages[path];
    }
    sessions[ORIGIN] = session;
    await storageSet({ [SESSIONS_KEY]: sessions });
  }

  // ======================================================================
  // 4. Apply a saved session to this page
  // ======================================================================
  function safeQueryAll(sel) {
    if (!sel) return [];
    try { return [...document.querySelectorAll(sel)]; } catch { return []; }
  }

  function resolveElement(el) {
    let m = safeQueryAll(el.selector);
    if (m.length === 1) return m[0];
    const byPath = safeQueryAll(el.domPath);
    if (byPath.length === 1) return byPath[0];
    if (m.length > 1) return m[0]; // ambiguous → first
    return null;
  }

  function findSpanForChange(change) {
    const el = change.element || {};
    const target = resolveElement(el);
    const ti = el.textIndex ?? 0;
    if (target) {
      const direct = [...target.children].filter((c) => c.matches?.("span.ce-track"));
      const hit = direct[ti];
      if (hit && originals.get(hit.getAttribute(ID_ATTR)) === change.original) return hit;
      for (const s of target.querySelectorAll("span.ce-track")) {
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

  // Seed `currents` from saved changes. Anything we can't place (element gone or
  // its text no longer matches the saved original) becomes an "orphan" — kept in
  // storage and surfaced in the panel as a warning, but not applied to the page.
  function applySaved(changes) {
    orphans = [];
    for (const change of changes || []) {
      if (change.kind === "image") { applyOneImage(change); continue; }
      const span = findSpanForChange(change);
      if (span && originals.get(span.getAttribute(ID_ATTR)) === change.original) {
        currents.set(span.getAttribute(ID_ATTR), change.edited);
      } else {
        orphans.push({ element: change.element || {}, original: change.original, edited: change.edited });
      }
    }
  }

  // ======================================================================
  // 4b. Images  (replace any <img> in place; preview adapts to the site's CSP)
  //
  // Images aren't wrapped like text — we mutate the <img> directly and keep a
  // parallel registry (imgEls/imgOriginals/imgCurrents/imgDescriptors). A
  // replacement is stored as a data: URL so it round-trips through storage and
  // the export bundle; the on-page PREVIEW picks the best scheme the page's CSP
  // actually allows, probed once per origin:
  //   data:  -> set <img src> to the data: URL            (most sites)
  //   blob:  -> set <img src> to an object URL             (data: blocked)
  //   none   -> keep the original image, show a badge       (both blocked)
  // ======================================================================
  const PROBE_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

  function probeImg(src) {
    return new Promise((resolve) => {
      const im = new Image();
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      im.onload = () => fin(im.naturalWidth > 0);
      im.onerror = () => fin(false);
      setTimeout(() => fin(false), 1500);
      im.src = src;
    });
  }

  let _imgScheme; // undefined until probed; then "data" | "blob" | "none"
  async function getImgScheme() {
    if (_imgScheme !== undefined) return _imgScheme;
    if (await probeImg(PROBE_PNG)) return (_imgScheme = "data");
    let url = null;
    try {
      url = URL.createObjectURL(dataUrlToBlob(PROBE_PNG, "image/png"));
      _imgScheme = (await probeImg(url)) ? "blob" : "none";
    } catch { _imgScheme = "none"; }
    finally { if (url) URL.revokeObjectURL(url); }
    return _imgScheme;
  }

  function dataUrlToBlob(dataUrl, type) {
    const comma = dataUrl.indexOf(",");
    const meta = dataUrl.slice(0, comma);
    const bin = atob(dataUrl.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const mime = type || (meta.match(/data:([^;]+)/) || [])[1] || "image/png";
    return new Blob([arr], { type: mime });
  }

  const blobUrls = new Map(); // id -> object URL (revoke on change/teardown)
  function ensureBlobUrl(id, cur) {
    revokeBlob(id);
    const u = URL.createObjectURL(dataUrlToBlob(cur.dataUrl, cur.fileType));
    blobUrls.set(id, u);
    return u;
  }
  function revokeBlob(id) {
    const u = blobUrls.get(id);
    if (u) { URL.revokeObjectURL(u); blobUrls.delete(id); }
  }

  // Tag every untracked <img> (idempotent — safe to re-run for late content).
  function snapshotImages() {
    for (const img of document.querySelectorAll("img")) {
      if (img.closest(`[${UI_ATTR}]`)) continue;
      if (img.hasAttribute(IMG_ID_ATTR)) continue;
      const id = "ceimg-" + idCounter++;
      img.setAttribute(IMG_ID_ATTR, id);
      imgEls.set(id, img);
      imgOriginals.set(id, {
        src: img.currentSrc || img.getAttribute("src") || img.src || "",
        srcset: img.getAttribute("srcset"),
        sizes: img.getAttribute("sizes"),
        alt: img.getAttribute("alt"),
      });
      imgDescriptors.set(id, describeElement(img));
    }
  }

  function restoreImgAttrs(id) {
    const img = imgEls.get(id), o = imgOriginals.get(id);
    revokeBlob(id);
    removeBadge(id);
    if (!img || !o) return;
    img.onerror = null;
    if (o.srcset) img.setAttribute("srcset", o.srcset); else img.removeAttribute("srcset");
    if (o.sizes) img.setAttribute("sizes", o.sizes); else img.removeAttribute("sizes");
    if (o.src != null) img.src = o.src;
    img.classList.remove("ce-img-changed");
  }

  // Both schemes refused: keep the original image visible, flag it with a badge.
  function applyBlocked(id) {
    const img = imgEls.get(id), o = imgOriginals.get(id);
    revokeBlob(id);
    if (img && o) { img.onerror = null; if (o.src != null) img.src = o.src; }
    imgBlocked.add(id);
    showBadge(id);
  }

  async function setImgPreview(id) {
    const img = imgEls.get(id);
    const cur = imgCurrents.get(id);
    if (!img) return;
    if (!cur) { restoreImgAttrs(id); imgBlocked.delete(id); return; }
    const scheme = await getImgScheme();
    if (!imgEls.has(id) || imgCurrents.get(id) !== cur) return; // changed mid-await
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    if (scheme === "none") { applyBlocked(id); return; }
    imgBlocked.delete(id);
    removeBadge(id);
    img.onerror = () => { img.onerror = null; applyBlocked(id); pushUpdate(); };
    img.src = scheme === "blob" ? ensureBlobUrl(id, cur) : cur.dataUrl;
  }

  function renderImages() {
    for (const id of imgCurrents.keys()) setImgPreview(id);
  }

  function setImgOutline(on) {
    for (const [id, img] of imgEls) {
      img.classList.toggle("ce-img-changed", !!(on && imgCurrents.get(id)));
    }
  }

  function replaceImageFromFile(id, file) {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = async () => {
      imgCurrents.set(id, { dataUrl: String(reader.result), fileName: file.name, fileType: file.type });
      await setImgPreview(id);
      setImgOutline(mode === "diff");
      await persist();
      pushUpdate();
    };
    reader.readAsDataURL(file);
  }

  // For storage/export: one record per replaced image.
  function buildImageChanges() {
    const out = [];
    for (const [id, cur] of imgCurrents) {
      if (!cur) continue;
      const o = imgOriginals.get(id) || {};
      out.push({
        kind: "image",
        element: imgDescriptors.get(id),
        original: o.src || "",
        edited: cur.dataUrl,
        alt: o.alt || null,
        fileName: cur.fileName || null,
        fileType: cur.fileType || null,
      });
    }
    return out;
  }

  function applyOneImage(change) {
    const target = resolveElement(change.element || {});
    if (target && target.tagName === "IMG" && target.hasAttribute(IMG_ID_ATTR)) {
      imgCurrents.set(target.getAttribute(IMG_ID_ATTR), {
        dataUrl: change.edited, fileName: change.fileName, fileType: change.fileType,
      });
    } else {
      orphans.push({
        kind: "image", element: change.element || {},
        original: change.original, edited: change.edited,
        fileName: change.fileName, fileType: change.fileType,
      });
    }
  }

  // --- Blocked-preview badge + hover "Replace image" button ----------------
  const badges = new Map(); // id -> badge element
  function showBadge(id) {
    if (badges.has(id)) return;
    const b = document.createElement("div");
    b.setAttribute(UI_ATTR, "");
    b.setAttribute("contenteditable", "false");
    b.className = "ce-img-badge";
    b.textContent = "\u26A0 Preview blocked by this site";
    b.title = "This site's security policy (CSP img-src) blocks images we add, so the " +
      "replacement can't display here. It's still saved and included when you export.";
    document.body.appendChild(b);
    badges.set(id, b);
    positionBadge(id);
  }
  function removeBadge(id) { const b = badges.get(id); if (b) { b.remove(); badges.delete(id); } }
  function removeAllBadges() { for (const b of badges.values()) b.remove(); badges.clear(); }
  function positionBadge(id) {
    const b = badges.get(id), img = imgEls.get(id);
    if (!b || !img) return;
    const r = img.getBoundingClientRect();
    b.style.left = Math.max(6, r.left + 6) + "px";
    b.style.top = Math.max(6, r.top + 6) + "px";
  }

  let imgBtn = null, imgInput = null, imgBtnId = null, pendingImgId = null;
  function injectImgUI() {
    imgInput = document.createElement("input");
    imgInput.type = "file";
    imgInput.accept = "image/*";
    imgInput.setAttribute(UI_ATTR, "");
    imgInput.style.display = "none";
    imgInput.addEventListener("change", () => {
      const f = imgInput.files && imgInput.files[0];
      const id = pendingImgId;   // captured at click time — hover/hide can't clear it
      pendingImgId = null;
      imgInput.value = "";
      if (f && id) replaceImageFromFile(id, f);
    });

    imgBtn = document.createElement("button");
    imgBtn.type = "button";
    imgBtn.id = "ce-img-btn";
    imgBtn.setAttribute(UI_ATTR, "");
    imgBtn.setAttribute("contenteditable", "false");
    imgBtn.textContent = "\u2B06 Replace image";
    imgBtn.style.display = "none";
    imgBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!imgBtnId) return;
      pendingImgId = imgBtnId;   // remember the target before the dialog steals hover
      imgInput.click();
    });

    document.body.append(imgInput, imgBtn);
  }

  function positionImgBtn() {
    const img = imgEls.get(imgBtnId);
    if (!img) return hideImgBtn();
    const r = img.getBoundingClientRect();
    if (r.width < 1 || r.bottom < 0 || r.top > innerHeight) return hideImgBtn();
    imgBtn.style.left = Math.max(6, r.right - imgBtn.offsetWidth - 8) + "px";
    imgBtn.style.top = Math.max(6, r.top + 8) + "px";
  }
  function showImgBtn(img) {
    imgBtnId = img.getAttribute(IMG_ID_ATTR);
    imgBtn.style.display = "inline-flex";
    positionImgBtn();
  }
  function hideImgBtn() { if (imgBtn) imgBtn.style.display = "none"; imgBtnId = null; }

  function onImgHover(e) {
    if (mode !== "edit") return;
    const t = e.target;
    if (t && t.tagName === "IMG" && t.hasAttribute(IMG_ID_ATTR)) showImgBtn(t);
  }
  function onImgOut(e) {
    if (mode !== "edit") return;
    const to = e.relatedTarget;
    if (to === imgBtn) return;
    if (to && to.tagName === "IMG" && to.hasAttribute(IMG_ID_ATTR)) return;
    hideImgBtn();
  }
  function positionOverlays() {
    if (imgBtn && imgBtn.style.display !== "none") positionImgBtn();
    for (const id of badges.keys()) positionBadge(id);
  }

  // ======================================================================
  // 5. Modes
  // ======================================================================
  const INTERCEPT_TYPES =
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "dblclick", "submit"];
  let intercepting = false;
  let interceptHandler = null;
  function setInterception(on) {
    if (on === intercepting) return;
    if (on) {
      interceptHandler = (e) => {
        const t = e.target;
        if (t && t.closest && t.closest(`[${UI_ATTR}]`)) return;
        e.stopImmediatePropagation();
        if (e.type === "click" || e.type === "auxclick" || e.type === "submit") e.preventDefault();
      };
      for (const ty of INTERCEPT_TYPES) window.addEventListener(ty, interceptHandler, true);
    } else if (interceptHandler) {
      for (const ty of INTERCEPT_TYPES) window.removeEventListener(ty, interceptHandler, true);
      interceptHandler = null;
    }
    intercepting = on;
  }

  function renderPlain() {
    document.documentElement.classList.remove("ce-review-mode");
    for (const [id, span] of spans) {
      const t = currents.get(id);
      if (span.textContent !== t) span.textContent = t;
    }
  }

  function renderDiff() {
    for (const [id, span] of spans) {
      const cur = currents.get(id);
      const orig = originals.get(id);
      span.textContent = "";
      if (cur === orig) span.textContent = cur;
      else span.appendChild(diffFragment(orig, cur));
    }
    document.documentElement.classList.add("ce-review-mode");
  }

  // Re-render the page in whatever mode we're currently in (used after we wrap
  // newly-rendered content so it shows up immediately).
  function renderCurrentMode() {
    if (mode === "diff") renderDiff();
    else renderPlain(); // edit + preview both show plain current text
  }

  // While editing, the live DOM text is authoritative; capture it into `currents`
  // before we leave Edit so Preview/Diff render what was typed.
  function captureEdits() {
    for (const [id, span] of spans) currents.set(id, span.textContent);
  }

  function enterEdit() {
    // Capture anything the page rendered since our last snapshot (lazy/hydrated
    // content), then re-apply this page's saved edits onto any new spans, so the
    // user edits — and we track — exactly what's on screen right now.
    snapshot();
    applySaved(savedChanges);
    const root = document.documentElement.classList;
    root.remove("ce-review-mode");
    root.add("ce-edit-mode");
    for (const [id, span] of spans) {
      if (span.textContent !== currents.get(id)) span.textContent = currents.get(id);
    }
    document.designMode = "on";
    setInterception(true);
    renderImages();
    setImgOutline(false);
    mode = "edit";
  }

  function enterPreview() {
    if (mode === "edit") captureEdits();
    document.documentElement.classList.remove("ce-edit-mode");
    document.designMode = "off";
    setInterception(false);
    renderPlain();
    renderImages();
    setImgOutline(false);
    hideImgBtn();
    mode = "preview";
  }

  function enterDiff() {
    if (mode !== "diff") preDiffMode = mode;
    if (mode === "edit") captureEdits();
    document.documentElement.classList.remove("ce-edit-mode");
    document.designMode = "off";
    setInterception(true);
    renderDiff();
    renderImages();
    setImgOutline(true);
    hideImgBtn();
    mode = "diff";
  }

  function enterMode(next) {
    if (next === "preview") enterPreview();
    else if (next === "diff") enterDiff();
    else enterEdit();
  }

  async function setMode(next) {
    if (next === mode) return;
    enterMode(next);
    await persist();
    pushUpdate();
  }

  // ======================================================================
  // 6. Current text / changes
  // ======================================================================
  function currentText(id) {
    if (mode === "edit") {
      const span = spans.get(id);
      return span ? span.textContent : originals.get(id);
    }
    return currents.has(id) ? currents.get(id) : originals.get(id);
  }

  function changedIds() {
    const ids = [];
    for (const [id, original] of originals) {
      if (currentText(id) !== original) ids.push(id);
    }
    return ids;
  }

  // For storage: applied edits on this page + replaced images + unresolved saved edits.
  function buildPageChanges() {
    const applied = changedIds().map((id) => ({
      element: descriptors.get(id),
      original: originals.get(id),
      edited: currentText(id),
    }));
    return applied.concat(buildImageChanges(), orphans);
  }

  // For the panel: current-page rows with live status + ids for Locate.
  function buildRows() {
    const rows = changedIds().map((id) => ({
      id,
      status: "applied",
      original: originals.get(id),
      edited: currentText(id),
      element: descriptors.get(id),
    }));
    const warn = orphans.map((c) => ({
      id: null,
      status: "warning",
      kind: c.kind === "image" ? "image" : "text",
      original: c.original,
      edited: c.edited,
      element: c.element || {},
    }));
    const imgRows = [];
    for (const [id, cur] of imgCurrents) {
      if (!cur) continue;
      imgRows.push({
        id,
        status: "applied",
        kind: "image",
        previewBlocked: imgBlocked.has(id),
        original: (imgOriginals.get(id) || {}).src || "",
        edited: cur.dataUrl,
        element: imgDescriptors.get(id),
      });
    }
    return rows.concat(imgRows, warn);
  }

  // ======================================================================
  // 7. Panel bridge
  // ======================================================================
  function send(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch {}
  }

  // -----------------------------------------------------------------------
  // Floating control (top-right): drives the three modes with two controls.
  // The primary button toggles Edit ("Done") ⇄ Preview ("Edit"). The "Diff"
  // iOS-style switch sits beside it whenever this page has edits: flip it ON to
  // overlay the inline diff, OFF to return to whichever mode you came from. It
  // carries UI_ATTR so the snapshot/interception ignore it.
  let floatEl = null, floatPrimary = null, floatDiff = null, floatSep = null, floatFrame = null, floatFrameText = null;

  function injectFloat() {
    const wrap = document.createElement("div");
    wrap.setAttribute(UI_ATTR, "");
    wrap.id = "ce-float";
    wrap.setAttribute("contenteditable", "false");

    floatDiff = document.createElement("button");
    floatDiff.setAttribute(UI_ATTR, "");
    floatDiff.type = "button";
    floatDiff.className = "ce-toggle";
    floatDiff.setAttribute("role", "switch");
    floatDiff.title = "Toggle an inline diff overlay of every change";
    const tLabel = document.createElement("span");
    tLabel.className = "ce-toggle-label";
    tLabel.textContent = "Diff";
    const track = document.createElement("span");
    track.className = "ce-toggle-track";
    const knob = document.createElement("span");
    knob.className = "ce-toggle-knob";
    track.appendChild(knob);
    floatDiff.append(tLabel, track);
    floatDiff.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      setMode(mode === "diff" ? preDiffMode : "diff");
    });

    floatPrimary = document.createElement("button");
    floatPrimary.setAttribute(UI_ATTR, "");
    floatPrimary.type = "button";
    floatPrimary.className = "ce-fab ce-fab-primary";
    floatPrimary.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      setMode(floatPrimary.dataset.target || "edit");
    });

    floatSep = document.createElement("span");
    floatSep.setAttribute(UI_ATTR, "");
    floatSep.className = "ce-sep";

    wrap.append(floatPrimary, floatSep, floatDiff);

    // Whole-page "you're in a special mode" cue: a fixed, click-through frame
    // that glows around the viewport, plus a status pill at the top edge. Color
    // is driven by the ce-edit-mode / ce-review-mode classes on <html>.
    floatFrame = document.createElement("div");
    floatFrame.setAttribute(UI_ATTR, "");
    floatFrame.id = "ce-frame";
    const label = document.createElement("span");
    label.setAttribute(UI_ATTR, "");
    label.className = "ce-frame-label";
    const dot = document.createElement("span");
    dot.className = "ce-frame-dot";
    floatFrameText = document.createElement("span");
    floatFrameText.className = "ce-frame-text";
    label.append(dot, floatFrameText);
    floatFrame.appendChild(label);

    document.body.append(floatFrame, wrap);
    return wrap;
  }

  function renderFloat() {
    if (!floatPrimary) return;
    if (mode === "edit") {
      floatPrimary.textContent = "Done";
      floatPrimary.dataset.target = "preview";
      floatPrimary.title = "Done editing — preview the page with your changes applied";
    } else {
      floatPrimary.textContent = "Edit";
      floatPrimary.dataset.target = "edit";
      floatPrimary.title = "Edit the page text in place";
    }
    // "Diff" switch: visible whenever there's something to diff (or we're in
    // diff mode), ON only while in diff mode.
    const showDiff = mode === "diff" || changedIds().length > 0;
    floatDiff.style.display = showDiff ? "" : "none";
    if (floatSep) floatSep.style.display = showDiff ? "" : "none";
    floatDiff.classList.toggle("is-on", mode === "diff");
    floatDiff.setAttribute("aria-checked", String(mode === "diff"));
    if (floatFrameText) {
      floatFrameText.textContent =
        mode === "edit" ? "Editing" : mode === "diff" ? "Reviewing changes" : "";
    }
  }

  function pushUpdate() {
    renderFloat();
    send({
      type: "ce:update",
      origin: ORIGIN,
      path: PATH,
      url: location.href,
      title: document.title,
      mode,
      rows: buildRows(),
    });
  }

  function flash(id) {
    const span = spans.get(id);
    if (span) {
      span.scrollIntoView({ behavior: "smooth", block: "center" });
      span.classList.add("ce-flash");
      setTimeout(() => span.classList.remove("ce-flash"), 1800);
      return true;
    }
    const img = imgEls.get(id);
    if (img) {
      img.scrollIntoView({ behavior: "smooth", block: "center" });
      img.classList.add("ce-flash");
      setTimeout(() => img.classList.remove("ce-flash"), 1800);
      return true;
    }
    return false;
  }

  // Live updates: while editing, recompute + persist as the user types.
  let pushTimer = null;
  function onInput() {
    if (mode !== "edit") return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => { await persist(); pushUpdate(); }, 250);
  }

  // ======================================================================
  // 8. Mutations driven by the panel
  // ======================================================================
  // Revert one applied change (by id) or drop one orphan (by original+edited).
  async function remove(payload) {
    if (payload.id != null && spans.has(payload.id)) {
      currents.set(payload.id, originals.get(payload.id));
      spans.get(payload.id).textContent = originals.get(payload.id);
    } else if (payload.id != null && imgEls.has(payload.id)) {
      restoreImgAttrs(payload.id);
      imgCurrents.delete(payload.id);
      imgBlocked.delete(payload.id);
      setImgOutline(mode === "diff");
    } else {
      orphans = orphans.filter(
        (o) => !(o.original === payload.original && o.edited === payload.edited)
      );
    }
    await persist();
    pushUpdate();
  }

  // Clear this page in place (used when the panel wipes the origin's session).
  // Does NOT persist — the panel has already removed the session from storage.
  function reset() {
    for (const [id, original] of originals) currents.set(id, original);
    for (const id of [...imgCurrents.keys()]) restoreImgAttrs(id);
    imgCurrents.clear();
    imgBlocked.clear();
    removeAllBadges();
    setImgOutline(false);
    orphans = [];
    savedChanges = [];
    renderCurrentMode();
    pushUpdate();
  }

  // ======================================================================
  // 8b. Late content + same-document (SPA) navigation
  //
  // The engine snapshots once at injection. Two things break that assumption:
  //   • Hydration: a site may render its real text just AFTER load, so the
  //     first snapshot wraps nothing useful. We re-snapshot during a short
  //     "settle" window and whenever the user enters Edit.
  //   • SPA routing: a link can swap the page without a reload, so PATH goes
  //     stale and tabs.onUpdated never fires "complete". We poll location and
  //     re-initialize for the new path.
  // ======================================================================
  let navPoll = null;
  let settleTimer = null;

  function watchNavigation() {
    window.addEventListener("popstate", onLocationMaybeChanged, true);
    navPoll = setInterval(onLocationMaybeChanged, 500);
  }
  function unwatchNavigation() {
    window.removeEventListener("popstate", onLocationMaybeChanged, true);
    clearInterval(navPoll); navPoll = null;
    stopSettle();
  }

  function onLocationMaybeChanged() {
    if (location.pathname === PATH) return; // unchanged or hash-only
    if (mode === "edit") captureEdits();
    try { persist(); } catch {}   // save the page we're leaving (persist captures old PATH)
    PATH = location.pathname;
    reinitForPage().catch((err) => console.error("[Copy Edit] re-init failed:", err));
  }

  // Drop the previous page's tracking (leaving our own UI intact) and rebuild
  // for the current PATH, re-applying its saved edits and the current mode.
  async function reinitForPage() {
    for (const span of spans.values()) {
      if (!span.isConnected) continue;
      const id = span.getAttribute(ID_ATTR);
      const text = document.createTextNode(originals.has(id) ? originals.get(id) : span.textContent);
      span.parentNode && span.parentNode.replaceChild(text, span);
    }
    spans.clear(); originals.clear(); currents.clear(); descriptors.clear(); orphans = [];
    for (const id of [...imgEls.keys()]) { restoreImgAttrs(id); const im = imgEls.get(id); im && im.removeAttribute(IMG_ID_ATTR); }
    imgEls.clear(); imgOriginals.clear(); imgCurrents.clear(); imgDescriptors.clear(); imgBlocked.clear();
    removeAllBadges(); hideImgBtn();

    snapshot();
    const sessions = await getSessions();
    const session = sessions[ORIGIN];
    savedChanges = (session && session.pages && session.pages[PATH] && session.pages[PATH].changes) || [];
    applySaved(savedChanges);
    enterMode(mode);
    pushUpdate();
    startSettle(); // the incoming view may still be rendering
  }

  // Wrap any text the page has rendered since the last pass. Skips re-applying
  // saved edits while editing so we never clobber the user's in-progress typing.
  function augment() {
    if (mode === "edit") captureEdits();
    const beforeText = spans.size;
    const beforeImg = imgEls.size;
    snapshot();
    if (spans.size === beforeText && imgEls.size === beforeImg) return; // nothing new
    if (mode !== "edit") applySaved(savedChanges);
    renderCurrentMode();
    renderImages();
    setImgOutline(mode === "diff");
    pushUpdate();
  }

  // Re-run augment() a few times over a short window to catch content that
  // renders progressively after load/navigation.
  function startSettle(ms = 3000) {
    stopSettle();
    const end = Date.now() + ms;
    const tick = () => {
      augment();
      settleTimer = Date.now() < end ? setTimeout(tick, 300) : null;
    };
    settleTimer = setTimeout(tick, 200);
  }
  function stopSettle() {
    clearTimeout(settleTimer); settleTimer = null;
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

      /* Floating menubar (top-right). Palette mirrors the side panel and adapts
         to light/dark with prefers-color-scheme, just like the panel does. */
      #ce-float { --ce-surface:rgba(255,255,255,.92); --ce-line:rgba(20,24,40,.10); --ce-ink:#1b1f2a; --ce-hover:rgba(20,24,40,.06); --ce-track:rgba(20,24,40,.22); --ce-shadow:0 10px 30px rgba(20,24,40,.22); --ce-accent-a:#4c7dff; --ce-accent-b:#6f57ff;
        position:fixed !important; top:16px !important; right:16px !important; z-index:2147483647 !important; display:inline-flex !important; align-items:center !important; gap:4px !important; margin:0 !important; padding:5px !important; border-radius:14px !important; background:var(--ce-surface) !important; -webkit-backdrop-filter:blur(12px) saturate(1.4); backdrop-filter:blur(12px) saturate(1.4); border:1px solid var(--ce-line) !important; box-shadow:var(--ce-shadow) !important; pointer-events:auto !important; }
      #ce-float .ce-sep { flex:0 0 auto !important; width:1px !important; align-self:stretch !important; margin:3px 2px !important; background:var(--ce-line) !important; }
      #ce-float .ce-fab { all:unset; box-sizing:border-box; cursor:pointer !important; display:inline-flex !important; align-items:center !important; justify-content:center !important; min-width:62px; padding:9px 16px !important; border-radius:10px !important; color:#fff !important; font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important; letter-spacing:.2px; transition:filter .14s ease, transform .05s ease; }
      #ce-float .ce-fab:hover { filter:brightness(1.08); }
      #ce-float .ce-fab:active { transform:translateY(1px); }
      #ce-float .ce-fab-primary { background:linear-gradient(135deg,var(--ce-accent-a),var(--ce-accent-b)) !important; }

      /* iOS-style "Diff" switch (right side of the bar): ON only in diff mode. */
      #ce-float .ce-toggle { all:unset; box-sizing:border-box; cursor:pointer !important; display:inline-flex !important; align-items:center !important; gap:8px !important; padding:7px 11px !important; border-radius:10px !important; color:var(--ce-ink) !important; font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important; letter-spacing:.2px; transition:background .14s ease; }
      #ce-float .ce-toggle:hover { background:var(--ce-hover) !important; }
      #ce-float .ce-toggle-label { color:var(--ce-ink) !important; }
      #ce-float .ce-toggle-track { position:relative !important; flex:0 0 auto !important; width:38px !important; height:22px !important; border-radius:999px !important; background:var(--ce-track) !important; transition:background .2s ease; }
      #ce-float .ce-toggle-knob { position:absolute !important; top:2px !important; left:2px !important; width:18px !important; height:18px !important; border-radius:50% !important; background:#fff !important; box-shadow:0 1px 3px rgba(0,0,0,.3) !important; transition:transform .2s ease; }
      #ce-float .ce-toggle.is-on .ce-toggle-track { background:linear-gradient(135deg,#f5a623,#f57c00) !important; }
      #ce-float .ce-toggle.is-on .ce-toggle-knob { transform:translateX(16px); }
      @media (prefers-color-scheme: dark) {
        #ce-float { --ce-surface:rgba(28,31,41,.94); --ce-line:rgba(255,255,255,.12); --ce-ink:#eef1f8; --ce-hover:rgba(255,255,255,.08); --ce-track:rgba(255,255,255,.20); --ce-shadow:0 12px 32px rgba(0,0,0,.5); --ce-accent-a:#6b94ff; --ce-accent-b:#6f57ff; }
      }

      /* Whole-page mode cue: a click-through glowing frame + a top-edge pill. */
      #ce-frame { position:fixed !important; inset:0 !important; z-index:2147483646 !important; pointer-events:none !important; opacity:0; transition:opacity .25s ease; }
      .ce-edit-mode #ce-frame, .ce-review-mode #ce-frame { opacity:1; }
      .ce-edit-mode #ce-frame { animation:ce-frame-breathe 3.4s ease-in-out infinite; }
      .ce-review-mode #ce-frame { box-shadow: inset 0 0 0 3px rgba(245,160,35,.95), inset 0 0 24px 4px rgba(245,124,0,.30) !important; }
      @keyframes ce-frame-breathe {
        0%,100% { box-shadow: inset 0 0 0 3px rgba(108,99,255,.80), inset 0 0 22px 3px rgba(76,125,255,.28); }
        50%     { box-shadow: inset 0 0 0 3px rgba(124,108,255,1), inset 0 0 44px 9px rgba(76,125,255,.52); }
      }
      #ce-frame .ce-frame-label { position:absolute !important; top:0 !important; left:50% !important; transform:translateX(-50%) !important; display:none; align-items:center; gap:7px; padding:6px 15px 7px !important; border-radius:0 0 12px 12px !important; color:#fff !important; font:700 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important; letter-spacing:.3px !important; white-space:nowrap !important; box-shadow:0 6px 18px rgba(20,24,40,.3) !important; }
      .ce-edit-mode #ce-frame .ce-frame-label, .ce-review-mode #ce-frame .ce-frame-label { display:flex !important; }
      .ce-edit-mode #ce-frame .ce-frame-label { background:linear-gradient(135deg,#4c7dff,#6f57ff) !important; }
      .ce-review-mode #ce-frame .ce-frame-label { background:linear-gradient(135deg,#f5a623,#f57c00) !important; }
      #ce-frame .ce-frame-dot { width:7px; height:7px; border-radius:50% !important; background:#fff !important; animation:ce-frame-dot 1.6s ease-out infinite; }
      @keyframes ce-frame-dot { 0%{ box-shadow:0 0 0 0 rgba(255,255,255,.65);} 70%{ box-shadow:0 0 0 6px rgba(255,255,255,0);} 100%{ box-shadow:0 0 0 0 rgba(255,255,255,0);} }
      @media (prefers-reduced-motion: reduce) {
        .ce-edit-mode #ce-frame { animation:none; box-shadow: inset 0 0 0 3px rgba(108,99,255,.9), inset 0 0 26px 4px rgba(76,125,255,.4) !important; }
        #ce-frame .ce-frame-dot { animation:none; }
      }

      /* Image edit: hover "Replace" button, blocked-preview badge, diff outline. */
      img.ce-flash { animation: ce-flash-kf 1.8s ease; }
      .ce-review-mode img.ce-img-changed { outline:3px solid #f5a623 !important; outline-offset:2px; box-shadow:0 0 0 6px rgba(245,160,35,.28) !important; }
      #ce-img-btn { position:fixed !important; z-index:2147483647 !important; display:none; align-items:center !important; gap:6px !important; margin:0 !important; padding:8px 12px !important; border:0 !important; border-radius:9px !important; cursor:pointer !important; color:#fff !important; font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important; letter-spacing:.2px; background:linear-gradient(135deg,#4c7dff,#6f57ff) !important; box-shadow:0 6px 18px rgba(20,24,40,.32) !important; }
      #ce-img-btn:hover { filter:brightness(1.08); }
      .ce-img-badge { position:fixed !important; z-index:2147483647 !important; max-width:230px !important; padding:6px 10px !important; border-radius:8px !important; background:rgba(20,24,40,.92) !important; color:#fff !important; font:600 11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important; box-shadow:0 6px 18px rgba(0,0,0,.38) !important; pointer-events:auto !important; }
    `;
    document.head.appendChild(style);
    return style;
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || !msg.cmd) return;
    switch (msg.cmd) {
      case "getState":
        pushUpdate();
        sendResponse({ ok: true, mode });
        break;
      case "setMode":
        setMode(msg.mode);
        sendResponse({ ok: true });
        break;
      case "locate":
        sendResponse({ ok: flash(msg.id) });
        break;
      case "remove":
        remove(msg);
        sendResponse({ ok: true });
        break;
      case "reset":
        reset();
        sendResponse({ ok: true });
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

  // Restore the page to its pristine state and unhook everything. The session
  // stays in storage; this is what "stopped" (panel closed) looks like.
  function teardown() {
    // Best-effort flush of the latest edits before we revert (covers closing the
    // panel right after a keystroke, before the debounced persist fired).
    try { persist(); } catch {}
    document.designMode = "off";
    document.documentElement.classList.remove("ce-review-mode", "ce-edit-mode");
    for (const span of spans.values()) {
      const id = span.getAttribute(ID_ATTR);
      const text = document.createTextNode(originals.has(id) ? originals.get(id) : span.textContent);
      span.parentNode && span.parentNode.replaceChild(text, span);
    }
    spans.clear(); originals.clear(); currents.clear(); descriptors.clear(); orphans = [];
    for (const id of [...imgEls.keys()]) { restoreImgAttrs(id); const im = imgEls.get(id); im && im.removeAttribute(IMG_ID_ATTR); }
    imgEls.clear(); imgOriginals.clear(); imgCurrents.clear(); imgDescriptors.clear(); imgBlocked.clear();
    removeAllBadges();
    for (const u of blobUrls.values()) { try { URL.revokeObjectURL(u); } catch {} }
    blobUrls.clear();
    setInterception(false);
    unwatchNavigation();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("mouseover", onImgHover, true);
    document.removeEventListener("mouseout", onImgOut, true);
    window.removeEventListener("scroll", positionOverlays, true);
    window.removeEventListener("resize", positionOverlays, true);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    floatEl && floatEl.remove();
    floatFrame && floatFrame.remove();
    floatEl = floatPrimary = floatDiff = floatSep = floatFrame = floatFrameText = null;
    imgBtn && imgBtn.remove();
    imgInput && imgInput.remove();
    imgBtn = imgInput = null; imgBtnId = null;
    pageStyle && pageStyle.remove();
    delete window.__copyEditTool;
    send({ type: "ce:gone" });
  }

  async function boot() {
    snapshot();
    pageStyle = injectPageStyle();
    floatEl = injectFloat();
    injectImgUI();
    document.addEventListener("input", onInput, true);
    document.addEventListener("mouseover", onImgHover, true);
    document.addEventListener("mouseout", onImgOut, true);
    window.addEventListener("scroll", positionOverlays, true);
    window.addEventListener("resize", positionOverlays, true);
    chrome.runtime.onMessage.addListener(onMessage);
    window.__copyEditTool = { teardown, pushUpdate };
    watchNavigation();

    const sessions = await getSessions();
    const session = sessions[ORIGIN];
    mode = (session && session.mode) || "edit";
    savedChanges = (session && session.pages && session.pages[PATH] && session.pages[PATH].changes) || [];
    if (savedChanges.length) applySaved(savedChanges);
    enterMode(mode);
    pushUpdate();
    startSettle(); // catch text the page renders just after load (hydration)
  }

  boot().catch((err) => {
    console.error("[Copy Edit] failed to start:", err);
    try { teardown(); } catch {}
  });
})();
