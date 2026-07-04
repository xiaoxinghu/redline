// image-replace.ts — the image-replacement subsystem for the in-page engine.
//
// Images can't be wrapped like text, so we mutate the <img> in place and keep a
// parallel registry keyed by our own id. This module owns that registry, the
// on-page "Replace image" hover button, the "preview blocked" badge, and the
// data:/blob: preview fallback for the page's CSP. It exposes a small facade to
// engine.ts (see ImageReplacer) and keeps everything else private.
//
// ROBUSTNESS — the two functions applyReplacement()/applyOriginal() are the
// single, idempotent source of truth for "show the replacement" / "show the
// original". A MutationObserver keep-alive re-asserts a replacement whenever the
// page mutates a replaced image out from under us (lazy-load libraries and
// SPA/framework re-renders routinely reset src/srcset after we've swapped). We
// tell our own writes apart from the site's by remembering the exact src we last
// wrote (lastApplied), so the observer never fights itself.
//
// PREVIEW SCHEME (probed once per origin):
//   data:  -> set <img src> to the data: URL            (most sites)
//   blob:  -> set <img src> to an object URL             (data: blocked)
//   none   -> keep the original image, show a badge       (both blocked)

export interface ImageReplacerDeps {
  /** Attribute used to tag tracked <img> elements (shared with the engine). */
  IMG_ID_ATTR: string;
  /** Attribute marking our own injected UI so snapshots/interception skip it. */
  UI_ATTR: string;
  /** Allocate the next globally-unique id (shares the engine's counter). */
  nextId: () => string;
  /** Describe an element's pristine identity (for storage/export + re-locating). */
  describeElement: (el: Element) => any;
  /** Re-locate an element from a stored descriptor, or null if it's gone. */
  resolveElement: (descriptor: any) => Element | null;
  /** The engine's current mode: 'edit' | 'preview' | 'diff'. */
  getMode: () => string;
  /** Record a saved change that couldn't be applied to this page. */
  addOrphan: (record: any) => void;
  /** Persist the current session. */
  persist: () => void;
  /** Re-report state to the side panel. */
  pushUpdate: () => void;
}

export interface ImageReplacer {
  /** Inject the hover UI and start the mousemove + keep-alive observers. */
  setup(): void;
  /** Full teardown: restore every image, untag, remove UI, revoke blobs. */
  destroy(): void;
  /** Tag any untracked <img> (idempotent — safe to re-run for late content). */
  scan(): void;
  /** Number of tracked images (lets the engine detect newly-rendered content). */
  count(): number;
  /** Re-apply every current replacement (idempotent). */
  render(): void;
  /** Toggle the diff outline on replaced images. */
  setOutline(on: boolean): void;
  /** Hide the hover "Replace image" button. */
  hideButton(): void;
  /** Reposition the button + badges (on scroll/resize). */
  reposition(): void;
  /** Scroll to + flash an image by id; true if this id was an image. */
  flash(id: string): boolean;
  /** Revert one replaced image by id; true if this id was an image. */
  revert(id: string): boolean;
  /** Revert every replacement but keep tracking (the panel's Reset). */
  revertAll(): void;
  /** Restore + untag every image and drop all state (SPA re-init). */
  clearPage(): void;
  /** Apply one saved image change (or record it as an orphan). */
  restoreSavedChange(change: any): void;
  /** One record per replaced image, for storage/export. */
  serializeChanges(): any[];
  /** Panel rows for replaced images. */
  serializeRows(): any[];
}

export function createImageReplacer(deps: ImageReplacerDeps): ImageReplacer {
  const {
    IMG_ID_ATTR, UI_ATTR, nextId, describeElement, resolveElement,
    getMode, addOrphan, persist, pushUpdate,
  } = deps;

  const imgEls = new Map();        // id -> <img>
  const imgOriginals = new Map();  // id -> { src, srcset, sizes, alt, sources } (pristine)
  const imgCurrents = new Map();   // id -> { dataUrl, fileName, fileType } (replacement)
  const imgDescriptors = new Map();// id -> element identity (computed pristine)
  const imgBlocked = new Set();    // ids whose preview the page's CSP refused
  // id -> the src string we last wrote. The keep-alive observer compares against
  // this to tell our own writes apart from the site clobbering the image.
  const lastApplied = new Map();

  // --- CSP preview scheme (data -> blob -> none), probed once per origin -----
  const PROBE_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

  function probeImg(src: string): Promise<boolean> {
    return new Promise((resolve) => {
      const im = new Image();
      let done = false;
      const fin = (v: boolean) => { if (!done) { done = true; resolve(v); } };
      im.onload = () => fin(im.naturalWidth > 0);
      im.onerror = () => fin(false);
      setTimeout(() => fin(false), 1500);
      im.src = src;
    });
  }

  let _imgScheme: string | undefined; // undefined until probed; then "data" | "blob" | "none"
  async function getImgScheme() {
    if (_imgScheme !== undefined) return _imgScheme;
    if (await probeImg(PROBE_PNG)) return (_imgScheme = 'data');
    let url = null;
    try {
      url = URL.createObjectURL(dataUrlToBlob(PROBE_PNG, 'image/png'));
      _imgScheme = (await probeImg(url)) ? 'blob' : 'none';
    } catch { _imgScheme = 'none'; }
    finally { if (url) URL.revokeObjectURL(url); }
    return _imgScheme;
  }

  function dataUrlToBlob(dataUrl: string, type?: string) {
    const comma = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, comma);
    const bin = atob(dataUrl.slice(comma + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const mime = type || (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
    return new Blob([arr], { type: mime });
  }

  const blobUrls = new Map(); // id -> object URL (revoke on change/teardown)
  function ensureBlobUrl(id: string, cur: any) {
    revokeBlob(id);
    const u = URL.createObjectURL(dataUrlToBlob(cur.dataUrl, cur.fileType));
    blobUrls.set(id, u);
    return u;
  }
  function revokeBlob(id: string) {
    const u = blobUrls.get(id);
    if (u) { URL.revokeObjectURL(u); blobUrls.delete(id); }
  }

  // --- Snapshot --------------------------------------------------------------
  function scan() {
    for (const img of document.querySelectorAll('img')) {
      if (img.closest(`[${UI_ATTR}]`)) continue;
      if (img.hasAttribute(IMG_ID_ATTR)) continue;
      const id = nextId();
      img.setAttribute(IMG_ID_ATTR, id);
      imgEls.set(id, img);
      imgOriginals.set(id, {
        src: (img as any).currentSrc || img.getAttribute('src') || (img as any).src || '',
        srcset: img.getAttribute('srcset'),
        sizes: img.getAttribute('sizes'),
        alt: img.getAttribute('alt'),
        sources: pictureSourcesOf(img),
      });
      imgDescriptors.set(id, describeElement(img));
    }
  }
  function count() { return imgEls.size; }

  // When an <img> lives inside a <picture>, the browser renders whichever
  // <source srcset> matches — it takes precedence over the <img> src. To swap
  // such an image we must neutralise those sources (and restore them later).
  function pictureSourcesOf(img: any) {
    const pic = img.parentElement;
    if (!pic || pic.tagName !== 'PICTURE') return [];
    return [...pic.querySelectorAll('source')].map((s: any) => ({ el: s, srcset: s.getAttribute('srcset') }));
  }
  function disablePictureSources(id: string) {
    const o = imgOriginals.get(id);
    if (!o || !o.sources) return;
    for (const s of o.sources) s.el.removeAttribute('srcset');
  }
  function restorePictureSources(id: string) {
    const o = imgOriginals.get(id);
    if (!o || !o.sources) return;
    for (const s of o.sources) {
      if (s.srcset != null) s.el.setAttribute('srcset', s.srcset); else s.el.removeAttribute('srcset');
    }
  }

  // --- Apply original / blocked / replacement (idempotent) -------------------
  function applyOriginal(id: string) {
    const img = imgEls.get(id), o = imgOriginals.get(id);
    revokeBlob(id);
    removeBadge(id);
    lastApplied.delete(id);
    if (!img || !o) return;
    img.onerror = null;
    restorePictureSources(id);
    if (o.srcset) img.setAttribute('srcset', o.srcset); else img.removeAttribute('srcset');
    if (o.sizes) img.setAttribute('sizes', o.sizes); else img.removeAttribute('sizes');
    if (o.src != null) img.src = o.src;
    img.classList.remove('rl-img-changed');
  }

  // Both schemes refused: keep the original image visible, flag it with a badge.
  function applyBlocked(id: string) {
    const img = imgEls.get(id), o = imgOriginals.get(id);
    revokeBlob(id);
    lastApplied.delete(id);
    if (img && o) { img.onerror = null; if (o.src != null) img.src = o.src; }
    restorePictureSources(id);
    imgBlocked.add(id);
    showBadge(id);
  }

  async function applyReplacement(id: string) {
    const img = imgEls.get(id);
    const cur = imgCurrents.get(id);
    if (!img) return;
    if (!cur) { applyOriginal(id); imgBlocked.delete(id); return; }
    const scheme = await getImgScheme();
    if (!imgEls.has(id) || imgCurrents.get(id) !== cur) return; // changed mid-await
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    if (scheme === 'none') { applyBlocked(id); return; }
    imgBlocked.delete(id);
    removeBadge(id);
    disablePictureSources(id);
    const url = scheme === 'blob' ? ensureBlobUrl(id, cur) : cur.dataUrl;
    lastApplied.set(id, url);   // record BEFORE the write so the observer skips it
    img.onerror = () => { img.onerror = null; applyBlocked(id); pushUpdate(); };
    img.src = url;
  }

  function render() {
    for (const id of imgCurrents.keys()) applyReplacement(id);
  }

  function setOutline(on: boolean) {
    for (const [id, img] of imgEls) {
      img.classList.toggle('rl-img-changed', !!(on && imgCurrents.get(id)));
    }
  }

  function replaceFromFile(id: string, file: File) {
    if (!file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = async () => {
      imgCurrents.set(id, { dataUrl: String(reader.result), fileName: file.name, fileType: file.type });
      await applyReplacement(id);
      setOutline(getMode() === 'diff');
      await persist();
      pushUpdate();
    };
    reader.readAsDataURL(file);
  }

  // --- Keep-alive: re-assert replacements the page clobbers ------------------
  let observer: MutationObserver | null = null;
  function onMutations(records: MutationRecord[]) {
    for (const rec of records) {
      const t: any = rec.target;
      if (!t || t.nodeType !== 1) continue;
      if (t.tagName === 'IMG' && t.hasAttribute(IMG_ID_ATTR)) {
        const id = t.getAttribute(IMG_ID_ATTR);
        if (!imgCurrents.has(id) || imgBlocked.has(id)) continue;
        const desired = lastApplied.get(id);
        // The site changed src away from what we wrote, or re-added a srcset that
        // would win over our src → re-assert the replacement.
        if ((desired != null && t.getAttribute('src') !== desired) || t.hasAttribute('srcset')) {
          applyReplacement(id);
        }
      } else if (t.tagName === 'SOURCE') {
        const pic = t.parentElement;
        const img = pic && pic.tagName === 'PICTURE' ? pic.querySelector(`img[${IMG_ID_ATTR}]`) : null;
        if (!img) continue;
        const id = img.getAttribute(IMG_ID_ATTR);
        if (imgCurrents.has(id) && !imgBlocked.has(id) && t.getAttribute('srcset')) applyReplacement(id);
      }
    }
  }

  // --- Storage / export / panel serialization --------------------------------
  function serializeChanges() {
    const out = [];
    for (const [id, cur] of imgCurrents) {
      if (!cur) continue;
      const o = imgOriginals.get(id) || {};
      out.push({
        kind: 'image',
        element: imgDescriptors.get(id),
        original: o.src || '',
        edited: cur.dataUrl,
        alt: o.alt || null,
        fileName: cur.fileName || null,
        fileType: cur.fileType || null,
      });
    }
    return out;
  }

  function serializeRows() {
    const rows = [];
    for (const [id, cur] of imgCurrents) {
      if (!cur) continue;
      rows.push({
        id,
        status: 'applied',
        kind: 'image',
        previewBlocked: imgBlocked.has(id),
        original: (imgOriginals.get(id) || {}).src || '',
        edited: cur.dataUrl,
        element: imgDescriptors.get(id),
      });
    }
    return rows;
  }

  function restoreSavedChange(change: any) {
    const target: any = resolveElement(change.element || {});
    if (target && target.tagName === 'IMG' && target.hasAttribute(IMG_ID_ATTR)) {
      imgCurrents.set(target.getAttribute(IMG_ID_ATTR), {
        dataUrl: change.edited, fileName: change.fileName, fileType: change.fileType,
      });
    } else {
      addOrphan({
        kind: 'image', element: change.element || {},
        original: change.original, edited: change.edited,
        fileName: change.fileName, fileType: change.fileType,
      });
    }
  }

  // --- Blocked-preview badge -------------------------------------------------
  const badges = new Map(); // id -> badge element
  function showBadge(id: string) {
    if (badges.has(id)) return;
    const b = document.createElement('div');
    b.setAttribute(UI_ATTR, '');
    b.setAttribute('contenteditable', 'false');
    b.className = 'rl-img-badge';
    b.textContent = '\u26A0 Preview blocked by this site';
    b.title = "This site's security policy (CSP img-src) blocks images we add, so the " +
      "replacement can't display here. It's still saved and included when you export.";
    document.body.appendChild(b);
    badges.set(id, b);
    positionBadge(id);
  }
  function removeBadge(id: string) { const b = badges.get(id); if (b) { b.remove(); badges.delete(id); } }
  function removeAllBadges() { for (const b of badges.values()) b.remove(); badges.clear(); }
  function positionBadge(id: string) {
    const b = badges.get(id), img = imgEls.get(id);
    if (!b || !img) return;
    const r = img.getBoundingClientRect();
    b.style.left = Math.max(6, r.left + 6) + 'px';
    b.style.top = Math.max(6, r.top + 6) + 'px';
  }

  // --- Hover "Replace image" button ------------------------------------------
  let imgBtn: any = null, imgInput: any = null, imgBtnId: string | null = null, pendingImgId: string | null = null;
  function injectImgUI() {
    imgInput = document.createElement('input');
    imgInput.type = 'file';
    imgInput.accept = 'image/*';
    imgInput.setAttribute(UI_ATTR, '');
    imgInput.style.display = 'none';
    imgInput.addEventListener('change', () => {
      const f = imgInput.files && imgInput.files[0];
      const id = pendingImgId;   // captured at click time — hover/hide can't clear it
      pendingImgId = null;
      imgInput.value = '';
      if (f && id) replaceFromFile(id, f);
    });

    imgBtn = document.createElement('button');
    imgBtn.type = 'button';
    imgBtn.id = 'rl-img-btn';
    imgBtn.setAttribute(UI_ATTR, '');
    imgBtn.setAttribute('contenteditable', 'false');
    imgBtn.textContent = '\u2B06 Replace image';
    imgBtn.style.display = 'none';
    imgBtn.addEventListener('click', (e: any) => {
      e.preventDefault(); e.stopPropagation();
      if (!imgBtnId) return;
      pendingImgId = imgBtnId;   // remember the target before the dialog steals hover
      imgInput.click();
    });

    document.body.append(imgInput, imgBtn);
  }

  function positionImgBtn() {
    const img = imgEls.get(imgBtnId);
    if (!img) return hideButton();
    const r = img.getBoundingClientRect();
    if (r.width < 1 || r.bottom < 0 || r.top > innerHeight) return hideButton();
    // Center the button over the *visible* portion of the image, so it stays
    // reachable even when the image is only partly scrolled into view.
    const cx = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
    const cy = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
    imgBtn.style.left = Math.round(cx - imgBtn.offsetWidth / 2) + 'px';
    imgBtn.style.top = Math.round(cy - imgBtn.offsetHeight / 2) + 'px';
  }
  function showImgBtn(img: any) {
    imgBtnId = img.getAttribute(IMG_ID_ATTR);
    imgBtn.style.display = 'inline-flex';
    positionImgBtn();
  }
  function hideButton() { if (imgBtn) imgBtn.style.display = 'none'; imgBtnId = null; }

  // Show the button when the pointer is over a registered image. We can't rely
  // on the mouseover *target* being the <img>: pages like apple.com stack
  // transparent scroll-animation layers on top of hero images, so the target is
  // always the overlay, never the image. Instead we probe the full element
  // stack under the cursor with elementsFromPoint (throttled).
  let lastImgProbe = 0;
  function onImgMove(e: any) {
    if (getMode() !== 'edit') return;
    const now = (performance && performance.now) ? performance.now() : Date.now();
    if (now - lastImgProbe < 60) return;
    lastImgProbe = now;
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    let img: any = null;
    for (const el of stack) {
      if (el === imgBtn) return;   // hovering the button itself — keep it as-is
      if (el.tagName === 'IMG' && el.hasAttribute(IMG_ID_ATTR)) { img = el; break; }
    }
    if (img) showImgBtn(img);
    else if (imgBtnId) hideButton();
  }

  function reposition() {
    if (imgBtn && imgBtn.style.display !== 'none') positionImgBtn();
    for (const id of badges.keys()) positionBadge(id);
  }

  // --- Panel-driven mutations & lifecycle ------------------------------------
  function flash(id: string) {
    const img = imgEls.get(id);
    if (!img) return false;
    img.scrollIntoView({ behavior: 'smooth', block: 'center' });
    img.classList.add('rl-flash');
    setTimeout(() => img.classList.remove('rl-flash'), 1800);
    return true;
  }

  function revert(id: string) {
    if (!imgEls.has(id)) return false;
    applyOriginal(id);
    imgCurrents.delete(id);
    imgBlocked.delete(id);
    setOutline(getMode() === 'diff');
    return true;
  }

  function revertAll() {
    for (const id of [...imgCurrents.keys()]) applyOriginal(id);
    imgCurrents.clear();
    imgBlocked.clear();
    removeAllBadges();
    setOutline(false);
  }

  function clearPage() {
    for (const id of [...imgEls.keys()]) { applyOriginal(id); const im = imgEls.get(id); im && im.removeAttribute(IMG_ID_ATTR); }
    imgEls.clear(); imgOriginals.clear(); imgCurrents.clear(); imgDescriptors.clear(); imgBlocked.clear();
    lastApplied.clear();
    removeAllBadges();
    hideButton();
  }

  function setup() {
    injectImgUI();
    document.addEventListener('mousemove', onImgMove, true);
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  function destroy() {
    observer && observer.disconnect(); observer = null;
    document.removeEventListener('mousemove', onImgMove, true);
    for (const id of [...imgEls.keys()]) { applyOriginal(id); const im = imgEls.get(id); im && im.removeAttribute(IMG_ID_ATTR); }
    imgEls.clear(); imgOriginals.clear(); imgCurrents.clear(); imgDescriptors.clear(); imgBlocked.clear();
    lastApplied.clear();
    removeAllBadges();
    for (const u of blobUrls.values()) { try { URL.revokeObjectURL(u); } catch {} }
    blobUrls.clear();
    imgBtn && imgBtn.remove();
    imgInput && imgInput.remove();
    imgBtn = imgInput = null; imgBtnId = null;
  }

  return {
    setup, destroy, scan, count, render, setOutline, hideButton, reposition,
    flash, revert, revertAll, clearPage, restoreSavedChange, serializeChanges, serializeRows,
  };
}
