# Copy Edit — inline diff + changeset (Chrome extension)

A Manifest V3 Chrome extension that lets a **content editor change web-page copy
in place**, then exports a **machine-readable changeset** that a developer can
**re-apply on their own machine** to see exactly what changed and where — and
that a **coding agent can read to locate the source in the codebase**.

No backend, no AI, nothing leaves the browser.

## The workflow it's built for

```
Content editor (their machine)              Developer (their machine)
────────────────────────────────           ─────────────────────────────────
1. Click the toolbar icon                   4. Open the SAME page/URL
2. Edit text directly on the page           5. Click the toolbar icon
3. Export  ─►  page.<ts>.copyedit.json ───► 6. Drag the file onto Chrome,
   (also copied to clipboard)                  Import it, or Paste it
                                            7. Changes re-apply as an inline
                                               diff + a panel listing each one
                                               with its selector & "Locate"
```

### Three caveat-free ways for the developer to apply a changeset
All use the File/Clipboard APIs — **no special permissions**, no `file://`, no
file-type association:

1. **Drag** the `.copyedit.json` onto the page (a drop overlay appears).
2. **Import** button → file picker.
3. **Paste** button → paste the JSON (handy when it arrives via email/Slack;
   Export also copies the changeset to the clipboard).

### Location-aware apply
If the changeset targets a different URL than the current tab, the tool stashes
it and offers **"Open & apply"**. Clicking it opens the target page **and
auto-activates the tool there**, which re-applies the pending changeset on boot
(valid for 10 minutes) — no second click needed.

## Toolbar

| Button | What it does |
|--------|--------------|
| **✏️ Edit** | `document.designMode = "on"` — edit any text in place. No diff markup, so nothing obstructs editing. || **🔍 Review** | Editing off; each changed text run renders inline `<ins>`/`<del>`, in place. |
| **☰ Changes** | Toggle a panel listing every change (selector, section, mini-diff, Locate). |
| **⬇︎ Export** | Download the changeset as `*.copyedit.json` (also copies it to the clipboard). |
| **⬆︎ Import** | Load a `*.copyedit.json` via file picker and re-apply it. |
| **📋 Paste** | Paste changeset JSON (e.g. from email/Slack) and re-apply it. |
| **↺ Reset** | Restore the original page text. |
| **✕** | Exit, unwrapping the page (keeps your edits). |

Re-clicking the toolbar icon also toggles the tool off. You can also **drag a
`.copyedit.json` onto the page** at any time while the tool is active.

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
- While the tool is active, the page's own **clicks/links/buttons are neutralised**
  (intercepted at the window capture phase) so you can click a link or button
  just to place the caret and edit its text — without triggering navigation or
  app behaviour. Caret placement and double-click word-select still work; our
  own toolbar is exempt. Exiting (✕) restores normal interaction.
- On activation it **snapshots** every meaningful text node by wrapping it in a
  `<span data-ce-id>` (wrapping *text nodes*, not whole elements, preserves the
  page's inline structure — links, `<strong>`, etc.).
- All element descriptors (`selector`, `domPath`, attributes, context) are
  computed on the **pristine DOM before wrapping**, so paths stay valid.
- Re-apply resolves each change by `selector` → `domPath` → unique-text fallback,
  then matches the `textIndex`-th text run whose text equals `original`.
- The diff is a dependency-free **word/whitespace token LCS** (no libraries to vet).
- The toolbar is in a **Shadow DOM** (style-isolated) and `contenteditable="false"`.

## Install (unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open `test/sample.html`, click the icon, fix the typos, **Review**, **Export**.
   Then open the same file in another tab, click the icon, **Import** the file.

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
- `manifest.json` — MV3 (`action` + `scripting` + `activeTab` + `storage`,
  plus `host_permissions` for `http(s)` so "Open & apply" can auto-inject into
  the tab it opens).
- `background.js` — service worker; injects `content.js` on toolbar click, and
  for "Open & apply" opens the target tab + auto-injects after it loads.
- `content.js` — snapshot, two-mode editing, inline diff, export + import
  (drag/picker/paste) + location-aware apply.
- `test/sample.html` — page with typos and React-style attributes to try it on.
