import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
//
// Most of the manifest is generated from the entrypoints:
//   - entrypoints/background.ts      -> background.service_worker
//   - entrypoints/sidepanel/         -> side_panel.default_path (+ "sidePanel" permission)
//   - entrypoints/engine.ts          -> /engine.js (unlisted script, injected on demand
//                                       by the side panel via chrome.scripting.executeScript)
// The rest (name, action, permissions, host permissions) is declared here.
export default defineConfig({
  modules: ['@wxt-dev/module-solid'],
  manifest: {
    name: 'Copy Edit — inline diff',
    action: {
      default_title: 'Copy Edit: open the editor side panel',
    },
    permissions: [
      'scripting',
      'activeTab',
      'storage',
      'sidePanel',
      'unlimitedStorage',
    ],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
