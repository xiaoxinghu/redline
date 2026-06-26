// Service worker (MV3).
//
// The UI lives in a Side Panel (sidepanel.html). Clicking the toolbar icon
// opens the panel; the panel itself injects content.js into the active tab and
// drives it over messaging, and persists the per-site editing session in
// chrome.storage.local. The only jobs left here are:
//   1. Make the toolbar icon open the side panel.
//   2. Detect when the side panel closes and tear the engine down in its tab,
//      so closing the editor returns the page to normal ("stopped").

// Open the side panel when the user clicks the toolbar icon.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[Copy Edit] setPanelBehavior failed:", err));

// Side-panel close detection. The side panel opens a long-lived port on load
// and keeps us told which tab it's driving (copyedit-target). When the panel
// document unloads — closed via the toolbar icon, the ✕, or by switching to
// another panel — the port disconnects. That's our signal to return the page to
// normal by tearing the engine down in the panel's current target tab. The saved
// session stays in storage and re-applies next time the panel opens.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "copyedit-panel") return;
  let tabId = null;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "copyedit-target") {
      tabId = typeof msg.tabId === "number" ? msg.tabId : null;
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, { cmd: "teardown" }, () => void chrome.runtime.lastError);
  });
});
