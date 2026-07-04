import { usePanel } from '../store';

/** Brand + status pill + the Export / Import / Clear actions. */
export default function Toolbar(props: { onImport: () => void }) {
  const { status, blocked, needsGrant, doExport, doClear } = usePanel();
  const disabled = () => blocked() != null || needsGrant() != null;

  return (
    <header class="bar">
      <div class="brand">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </span>
        <span class="name">Copy&nbsp;Edit</span>
        <span class="status">{status()}</span>
      </div>

      <div class="actions">
        <button class="act" disabled={disabled()} title="Download the whole-site session & copy it to the clipboard" onClick={() => doExport()}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
          Export
        </button>
        <button class="act" disabled={disabled()} title="Apply a session file" onClick={() => props.onImport()}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
          Import
        </button>
        <button class="act ghost" disabled={disabled()} title="Clear all saved changes for this site" onClick={() => doClear()}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
          Clear
        </button>
      </div>
    </header>
  );
}
