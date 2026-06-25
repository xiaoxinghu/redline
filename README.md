# Copy Edit — inline diff + changeset (Chrome extension)

A Manifest V3 Chrome extension that lets a **content editor change web-page copy
in place** from a **side panel**, then exports a **machine-readable changeset**
that a developer can **re-apply on their own machine** to see exactly what
changed and where — and that a **coding agent can read to locate the source in
the codebase**.

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
2. **Drag** the `.copyedit.json` onto the **side panel** (a drop overlay
   appears). Share also copies the changeset to the clipboard.

### Location-aware apply
If the changeset targets a different URL than the current tab, the tool stashes
it and the panel offers **"Open & apply"**. Clicking it opens the target page
**and auto-activates the tool there**, which re-applies the pending changeset on
boot (valid for 10 minutes) — no second click needed.

## The UI lives in a side panel

Clicking the toolbar icon opens Chrome's **side panel** (`chrome.sidePanel`,
Chrome 114+). The panel injects the in-page engine into the active tab and
drives it over messaging. An **elegant toolbar** is pinned to the top; the rest
of the panel is a **live list of every change** (with inline diffs).

| Toolbar control | What it does |
|-----------------|--------------|
| **Edit / Review** | Segmented toggle. *Edit*: `designMode = "on"`, edit text in place with no markup. *Review*: editing off, each changed run renders inline `<ins>`/`<del>` on the page. |
| **Share** | Download the changeset as `*.copyedit.json` (also copies it to the clipboard). |
| **Import** | Load a `*.copyedit.json` via file picker and re-apply it (drag-and-drop onto the panel also works). |
| **Done** | Stop editing and remove the in-page markup (your text edits stay). |

**Reset = reload.** There is no Reset button — edits live only in memory, so a
plain page reload (**⌘R / Ctrl R**) restores the original text and the panel
re-activates fresh against it.

Switching the active tab re-points the panel at the new tab; reloading the page
re-activates the engine automatically.

## The changeset format (`*.copyedit.json`)

This is the deliverable — designed to round-trip *and* to be read by a coding agent.

```jsonc
{
  "format": "copy-edit-changeset",
  "version": 1,
  "readme": "…how to re-apply and how to locate the source in code…",
  "page": {
    "url": "https://acme.example.com/about",
    "origin": "https://acme.example.com",
    "path": "/about",
    "title": "Acme — About",
    "lang": "en",
    "viewport": { "width": 1280, "height": 800 },
    "capturedAt": "2026-06-25T…Z"
  },
  "summary": {
    "changeCount": 4,
    "distinctOriginals": ["beleive", "familys", …]
  },
  "changes": [
    {
      "index": 1,
      "original": "At Acme, we beleive that everyone…",   // ← exact grep target
      "edited":   "At Acme, we believe that everyone…",
      "diffPreview": "At Acme, we [-beleive][+believe] that everyone…",
      "element": {
        "tag": "p",
        "id": null,
        "classes": ["IntroParagraph"],
        "componentHint": "IntroParagraph",   // from data-component / data-testid / CSS-module class
        "attributes": { "data-component": "IntroParagraph" },  // all data-* / aria-* + href/role/name/…
        "selector": "body > p:nth-of-type(1)",   // id-aware, readable
        "domPath": "body > p:nth-of-type(1)",     // deterministic positional path
        "elementText": "At Acme, we beleive…",     // full element text for context
        "textIndex": 0,                            // which text-run inside the element
        "context": { "nearestHeading": "Welcome to Acme Insurance", "landmark": "main" }
      }
    }
  ]
}
```

### For a coding agent locating the source
1. **Search the codebase for the exact `original` string** — usually the fastest hit.
2. Disambiguate with `element.id`, `element.classes`, `element.componentHint`,
   and `element.attributes` (`data-testid`/`data-component` map directly to React
   components/props).
3. Use `element.context.nearestHeading` + `page.path` to find the right
   page/route/section when the same string appears more than once.

> Mapping copy → source is inherently framework-dependent (the text may live in
> JSX, a CMS, a JSON locale file, etc.). This format doesn't guess the file — it
> gives an agent the strongest possible signals to find it quickly.

## How it works under the hood
- The UI is a **side panel page** (`sidepanel.html/.css/.js`). It has no access
  to the page DOM, so it injects **`content.js`** (the engine) into the active
  tab and talks to it over messaging (`chrome.tabs.sendMessage` →, `ce:update`
  ←). The panel renders the toolbar + the live change list; the engine does all
  DOM work.
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

## Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open `test/sample.html`, click the icon to open the side panel, fix the
   typos, switch to **Review**, then **Share**. Open the same file in another
   tab, click the icon, and **Import** (or drag) the file.

## Known limitations (MVP)
- Best for **editing existing text in place**. Big structural edits in
  `designMode` (merging paragraphs, deleting blocks, Enter to make new nodes)
  aren't fully tracked.
- Re-apply works best on the **same URL with matching content**; if the dev page
  has drifted, those changes show as **"not found"** in the panel (surfaced, not
  silently dropped). A page-path mismatch shows a warning banner.
- SPA frameworks may re-render and discard the injected spans; intended for your
  own mostly-static content pages.

## Files
- `manifest.json` — MV3 (`action` + `side_panel` + `scripting` + `activeTab` +
  `storage` + `sidePanel`, plus `host_permissions` for `http(s)` so the panel
  can inject the engine and "Open & apply" can auto-inject into a new tab).
- `background.js` — service worker; opens the side panel on toolbar click
  (`setPanelBehavior`), and for "Open & apply" opens the target tab + injects.
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the side-panel UI:
  elegant toolbar + live change list, Share/Import, drag-and-drop, toasts.
- `content.js` — the in-page engine: snapshot, two-mode editing, inline diff,
  export/import + location-aware apply. No UI of its own.
- `test/sample.html` — page with typos and React-style attributes to try it on.
