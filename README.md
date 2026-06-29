# Copy Edit — inline diff + changeset (Chrome extension)

A Manifest V3 Chrome extension that lets a **content editor change web-page copy
and images in place** from a **side panel**, then exports a **machine-readable
changeset** that a developer can **re-apply on their own machine** to see exactly
what changed and where — and that a **coding agent can read to locate the source
in the codebase**.

No backend, no AI, nothing leaves the browser.

## The workflow it's built for

```
Content editor (their machine)              Developer (their machine)
────────────────────────────────           ─────────────────────────────────
1. Click the toolbar icon → side panel      4. Open the SAME page/URL
2. Edit text directly on the page           5. Click the icon → side panel
3. Share ─► page.<ts>.copyedit.json ──────► 6. Drag the file onto the panel
   (also copied to clipboard)                  or Import it
                                            7. Changes re-apply as an inline
                                               diff + the panel lists each one
                                               with its selector & "Locate"
```

### Two caveat-free ways for the developer to apply a changeset
Both use the File API — **no special permissions**, no `file://`, no file-type
association:

1. **Import** button → file picker.
2. **Drag** the `.copyedit-bundle.zip` onto the **side panel** (a drop overlay
   appears). Share also copies the JSON manifest to the clipboard.

### Location-aware apply
If the changeset targets a different URL than the current tab, the tool stashes
it and the panel offers **"Open & apply"**. Clicking it opens the target page
**and auto-activates the tool there**, which re-applies the pending changeset on
boot (valid for 10 minutes) — no second click needed.

## Editing images

In **Edit** mode, hovering any `<img>` reveals a **Replace image** button; click
it to pick a local file and the image is swapped in place. The replacement is
kept in the session and travels in the export bundle as a real file under
`assets/`, referenced by filename from the changeset.

### Preview adapts to the site's security policy
A replaced image can only be shown on the page through a `data:`/`blob:` URL, and
a site's **`img-src` Content-Security-Policy** decides whether the browser will
load those. Copy Edit probes the live page once per origin and picks the best
scheme it actually allows:

1. **`data:`** on the real `<img>` (most sites — full fidelity), else
2. **`blob:`** on the real `<img>` (when `data:` is blocked), else
3. a small **badge** on the image explaining the preview is blocked.

In every case the replacement is still saved and included in the export — only
the *live preview* degrades on a strict-CSP site. (Scope is plain `<img>` for
now; CSS background-images, `<picture>`/`srcset` swapping, and inline SVG are out
of scope.)

## The UI lives in a side panel

Clicking the toolbar icon opens Chrome's **side panel** (`chrome.sidePanel`,
Chrome 114+). The panel injects the in-page engine into the active tab and
drives it over messaging. An **elegant toolbar** is pinned to the top; the rest
of the panel is a **live list of every change** (with inline diffs).

| Toolbar control | What it does |
|-----------------|--------------|
| **Edit / Review** | Segmented toggle. *Edit*: `designMode = "on"`, edit text in place with no markup; hovering any image shows a **Replace image** button. *Review*: editing off, each changed run renders inline `<ins>`/`<del>` and each replaced image gets an outline. |
| **Share** | Download the changeset as a `*.copyedit-bundle.zip` (also copies the JSON manifest to the clipboard). |
| **Import** | Load a `*.copyedit-bundle.zip` (or a legacy `*.copyedit-session.json`) via file picker and re-apply it (drag-and-drop onto the panel also works). |
| **Done** | Stop editing and remove the in-page markup (your text edits stay). |

**Reset = reload.** There is no Reset button — edits live only in memory, so a
plain page reload (**⌘R / Ctrl R**) restores the original text and the panel
re-activates fresh against it.

Switching the active tab re-points the panel at the new tab; reloading the page
re-activates the engine automatically.

## The changeset format (`*.copyedit-bundle.zip`)

The deliverable is a **zip bundle** — designed to round-trip *and* to be read by
a coding agent:

```
acme-example-com.2026-06-25-12-00-00.copyedit-bundle.zip
├── changeset.json        ← the machine-readable manifest (below)
└── assets/
    ├── img-1.png          ← replacement images, referenced by `file`
    └── img-2.jpg
```

Text changes carry the exact `original`/`edited` strings inline; image changes
carry the original `original` src plus a `file` pointing at the replacement in
`assets/`. `changeset.json` looks like:

```jsonc
{
  "format": "copy-edit-session",
  "version": 2,
  "readme": "…how to re-apply and how to locate the source in code…",
  "origin": "https://acme.example.com",
  "summary": { "pageCount": 1, "changeCount": 4, "imageCount": 1 },
  "pages": [
    {
      "path": "/about",
      "changes": [
        {
          "index": 1,
          "kind": "text",
          "original": "At Acme, we beleive that everyone…",   // ← exact grep target
          "edited":   "At Acme, we believe that everyone…",
          "diffPreview": "At Acme, we [-beleive][+believe] that everyone…",
          "element": {
            "tag": "p",
            "componentHint": "IntroParagraph",   // from data-component / data-testid / CSS-module class
            "attributes": { "data-component": "IntroParagraph" },
            "selector": "body > p:nth-of-type(1)",
            "domPath": "body > p:nth-of-type(1)",
            "context": { "nearestHeading": "Our promise", "landmark": "main" }
          }
        },
        {
          "index": 2,
          "kind": "image",
          "original": "https://acme.example.com/hero.png",   // ← the image being replaced
          "file": "assets/img-1.png",                          // ← the replacement, in this zip
          "alt": "Family on a beach",
          "element": {
            "tag": "img",
            "componentHint": "HeroImage",
            "attributes": { "data-component": "HeroImage", "alt": "Family on a beach" },
            "selector": "body > main > figure > img",
            "context": { "nearestHeading": "Welcome to Acme Insurance", "landmark": "main" }
          }
        }
      ]
    }
  ]
}
```

### For a coding agent locating the source
1. **Text:** search the codebase for the exact `original` string — usually the fastest hit.
2. **Images:** match on `element.selector`/`element.domPath`, `element.componentHint`,
   `element.attributes` (`data-component`/`data-testid`), and the original `original`
   src/filename; the intended new asset is the `file` in the bundle.
3. Disambiguate with `element.id`, `element.classes`, and `element.context.nearestHeading`
   + `page.path` when the same string/component appears more than once.

> Mapping copy → source is inherently framework-dependent (the text may live in
> JSX, a CMS, a JSON locale file, etc.). This format doesn't guess the file — it
> gives an agent the strongest possible signals to find it quickly.

## How it works under the hood
- Built with **[WXT](https://wxt.dev)** (Vite-based). Source lives in
  `entrypoints/` and is bundled into `.output/chrome-mv3/` — `manifest.json` is
  **generated** from `wxt.config.ts` + the entrypoints, not hand-written.
- The UI is a **side panel page** (`entrypoints/sidepanel/`). It has no access
  to the page DOM, so it injects the **engine** (`entrypoints/engine.ts`, built
  to `/engine.js`) into the active tab via `chrome.scripting.executeScript` and
  talks to it over messaging (`chrome.tabs.sendMessage` →, `ce:update` ←). The
  panel renders the toolbar + the live change list; the engine does all DOM
  work. The engine is an **unlisted script** — only ever injected on demand,
  never auto-run on page load.
- While the tool is active, the page's own **clicks/links/buttons are neutralised**
  (intercepted at the window capture phase) so you can click a link or button
  just to place the caret and edit its text — without triggering navigation or
  app behaviour. Caret placement and double-click word-select still work.
- On activation it **snapshots** every meaningful text node by wrapping it in a
  `<span data-ce-id>` (wrapping *text nodes*, not whole elements, preserves the
  page's inline structure — links, `<strong>`, etc.).
- All element descriptors (`selector`, `domPath`, attributes, context) are
  computed on the **pristine DOM before wrapping**, so paths stay valid.
- Re-apply resolves each change by `selector` → `domPath` → unique-text fallback,
  then matches the `textIndex`-th text run whose text equals `original`.
- The diff is a dependency-free **word/whitespace token LCS** (no libraries to
  vet). The engine ships diff *tokens* to the panel, which builds `<ins>`/`<del>`
  as DOM (never HTML), so page text can't inject markup into the panel.

## Develop & build (WXT)
Requires [Bun](https://bun.sh) (or npm/pnpm).

```sh
bun install        # installs deps + runs `wxt prepare`
bun run dev        # launches Chrome with the extension + HMR
bun run build      # production build -> .output/chrome-mv3/
bun run compile    # type-check (tsc --noEmit)
bun run zip        # packaged .zip for the Web Store
```

### Install (unpacked)
1. `bun run build`.
2. `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select **`.output/chrome-mv3/`**.
4. Open `test/sample.html`, click the icon to open the side panel, fix the
   typos, switch to **Review**, then **Share**. Open the same file in another
   tab, click the icon, and **Import** (or drag) the file.

> `bun run dev` does the load-unpacked step for you and live-reloads on change.

## Known limitations (MVP)
- Best for **editing existing text in place** and **replacing existing `<img>`
  elements**. Big structural edits in `designMode` (merging paragraphs, deleting
  blocks, Enter to make new nodes) aren't fully tracked.
- **Image preview vs. CSP:** on a site whose `img-src` policy blocks both `data:`
  and `blob:`, the swapped image can't render live (a badge explains why) — the
  replacement is still saved and exported. Image editing targets plain `<img>`
  only (no CSS backgrounds, `<picture>`/`srcset`, or inline SVG).
- Re-apply works best on the **same URL with matching content**; if the dev page
  has drifted, those changes show as **"not found"** in the panel (surfaced, not
  silently dropped). A page-path mismatch shows a warning banner.
- SPA frameworks may re-render and discard the injected spans; intended for your
  own mostly-static content pages.

## Files
WXT bundles `entrypoints/` into the extension; `manifest.json` is generated.
- `wxt.config.ts` — declares `name`, `action`, `permissions` (`scripting` +
  `activeTab` + `storage` + `sidePanel` + `unlimitedStorage` so replacement-image
  bytes fit in `chrome.storage.local`) and `host_permissions` for `http(s)` so
  the panel can inject the engine and "Open & apply" can auto-inject into a new
  tab. WXT adds the `sidePanel` permission automatically and `side_panel` /
  `background` / `icons` from the entrypoints + `public/`.
- `entrypoints/background.ts` — service worker; opens the side panel on toolbar
  click (`setPanelBehavior`) and tears the engine down when the panel closes.
- `entrypoints/sidepanel/` — the side-panel UI, a **SolidJS** app
  (`@wxt-dev/module-solid`). `index.html` mounts `main.tsx`, which renders
  `App.tsx`; `store.ts` holds all chrome messaging/storage behind reactive
  signals (exposed via `usePanel()`), and `components/` breaks the UI into
  reusable pieces (`Toolbar`, `ChangeList` → `ChangeGroup` → `ChangeRow`,
  `Diff`, `StateMessage`, `DropOverlay`, `Toasts`). `style.css` is shared.
  Together: elegant toolbar + live change list (text diffs + image before→after
  thumbnails), Share/Import, drag-and-drop, toasts.
- `entrypoints/engine.ts` — the in-page engine (built to `/engine.js`): snapshot,
  three-mode editing, inline diff, in-place image replacement with CSP-aware
  preview, export/import + location-aware apply. No UI of its own beyond a
  floating mode toggle + the image hover button.
- `utils/zip.ts` — a tiny dependency-free ZIP reader/writer (store method) used
  by the panel to build and read the `*.copyedit-bundle.zip` export.
- `utils/bundle.ts` — builds/reads the export bundle (zip + image bytes) on top
  of `zip.ts`; `utils/diff.ts` — the word-level diff shared by the UI + export;
  `utils/sessions.ts` — per-origin `chrome.storage.local` session helpers.
- `utils/types.ts` — shared TypeScript types for the changeset/session/message
  contracts.
- `public/icon/` — toolbar/extension icons (auto-discovered by WXT).
- `test/sample.html` — page with typos, React-style attributes, and images to try it on.
