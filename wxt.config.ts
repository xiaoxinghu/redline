import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
//
// Most of the manifest is generated from the entrypoints:
//   - entrypoints/background.ts      -> background.service_worker
//   - entrypoints/sidepanel/         -> side_panel.default_path (+ "sidePanel" permission)
//   - entrypoints/engine.ts          -> /engine.js (unlisted script, injected on demand
//                                       by the side panel via chrome.scripting.executeScript)
// The rest (name, action, permissions, host permissions) is declared here.
export default defineConfig({
	modules: ["@wxt-dev/module-solid"],
	manifest: {
		name: "Redline — inline diff",
		// Chrome Web Store caps manifest description at 132 chars.
		// (package.json's longer description would otherwise be used.)
		description:
			"Edit page text inline from a side panel, track changes with live inline diffs, and share a machine-readable changeset to re-apply.",
		action: {
			default_title: "Redline: open the editor side panel",
		},
		permissions: [
			"scripting",
			"activeTab",
			"storage",
			"sidePanel",
			"unlimitedStorage",
		],
		host_permissions: ["http://*/*", "https://*/*"],
	},
});
