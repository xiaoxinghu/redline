// Service worker (MV3). Injects the tool on toolbar click.
// Re-clicking re-runs content.js, which toggles the tool off if already active.

const RESTRICTED = /^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  // Chrome blocks script injection on its own pages and the Web Store.
  if (RESTRICTED.test(tab.url || "") || /https:\/\/chrome\.google\.com\/webstore/.test(tab.url || "")) {
    chrome.action.setTitle({
      tabId: tab.id,
      title: "Copy Edit can't run on this page (restricted URL).",
    });
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (err) {
    console.error("[Copy Edit] injection failed:", err);
  }
});

// "Open & apply": the content script (on a non-matching page) stashes a pending
// changeset and asks us to open its target URL. We open the tab AND inject the
// tool once the page finishes loading, so it auto-applies on boot. (activeTab
// can't cover a programmatically opened tab — hence host_permissions.)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "copyedit-open-and-apply" && msg.url) {
    openAndApply(msg.url);
    sendResponse({ ok: true }); // synchronous ack so the sender won't fall back
  }
});

async function openAndApply(url) {
  if (RESTRICTED.test(url) || /https:\/\/chrome\.google\.com\/webstore/.test(url)) {
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

  // Inject only after the new tab has finished loading, so content.js can
  // snapshot the live DOM and maybeApplyPending() finds the stashed changeset.
  const onUpdated = (updatedTabId, info) => {
    if (updatedTabId !== tabId || info.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["content.js"] })
      .catch((err) => console.error("[Copy Edit] auto-apply injection failed:", err));
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
}
