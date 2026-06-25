// Service worker (MV3).
//
// The UI now lives in a Side Panel (sidepanel.html). Clicking the toolbar icon
// opens the panel; the panel itself injects content.js into the active tab and
// drives it over messaging. The only jobs left here are:
//   1. Make the toolbar icon open the side panel.
//   2. "Open & apply": open a changeset's target URL and inject the tool so it
//      auto-applies the stashed changeset on boot.

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;
const isRestricted = (url) =>
  RESTRICTED.test(url || "") || /https:\/\/chrome\.google\.com\/webstore/.test(url || "");

// Open the side panel when the user clicks the toolbar icon.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[Copy Edit] setPanelBehavior failed:", err));

// "Open & apply": the side panel stashed a pending changeset whose target URL
// differs from the current tab. Open that URL and inject the tool once it has
// loaded, so maybeApplyPending() re-applies the changeset on boot.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "copyedit-open-and-apply" && msg.url) {
    openAndApply(msg.url);
    sendResponse({ ok: true }); // synchronous ack so the sender won't fall back
  }
});

async function openAndApply(url) {
  if (isRestricted(url)) {
    console.warn("[Copy Edit] can't auto-apply on a restricted URL:", url);
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url });
  } catch (err) {
    console.error("[Copy Edit] could not open tab:", err);
    return;
  }
  const tabId = tab.id;

  const onUpdated = (updatedTabId, info) => {
    if (updatedTabId !== tabId || info.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .catch((err) => console.error("[Copy Edit] auto-apply injection failed:", err));
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
}
