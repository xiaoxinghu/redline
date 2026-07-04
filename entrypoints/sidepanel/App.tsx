import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { createPanelStore, PanelContext } from './store';
import Toolbar from './components/Toolbar';
import ChangeList from './components/ChangeList';
import StateMessage from './components/StateMessage';
import DropOverlay from './components/DropOverlay';
import Toasts from './components/Toasts';

export default function App() {
  const store = createPanelStore();
  let fileInput: HTMLInputElement | undefined;
  const [dragging, setDragging] = createSignal(false);

  const openFilePicker = () => fileInput?.click();
  const onFileChange = async (e: Event & { currentTarget: HTMLInputElement }) => {
    const f = e.currentTarget.files?.[0];
    if (f) await store.applyFile(f);
    e.currentTarget.value = '';
  };

  // Drag a bundle file anywhere onto the panel to apply it.
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const onDragOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true); } };
  const onDragEnter = (e: DragEvent) => { if (hasFiles(e)) { dragDepth++; setDragging(true); } };
  const onDragLeave = () => { if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); } };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    setDragging(false);
    store.applyFile(e.dataTransfer.files[0]);
  };

  onMount(() => {
    store.init();
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
  });
  onCleanup(() => {
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
  });

  return (
    <PanelContext.Provider value={store}>
      <div id="app">
        <Toolbar onImport={openFilePicker} />
        <Show
          when={store.needsGrant()}
          fallback={
            <Show
              when={store.blocked()}
              fallback={
                <Show
                  when={store.groups().length}
                  fallback={
                    <StateMessage
                      art="✎"
                      title="No changes yet"
                      sub="Click any text on the page and start typing. Edits are saved per site and reappear as you browse."
                    />
                  }
                >
                  <ChangeList />
                </Show>
              }
            >
              <StateMessage art="⊘" title="Can't run here" sub={store.blocked()!} />
            </Show>
          }
        >
          <StateMessage
            art="🔒"
            title="Enable Redline on this site"
            sub={
              store.needsGrant()!.host
                ? `Grant Redline permission to edit ${store.needsGrant()!.host}. Your changes stay in this browser — nothing is sent anywhere.`
                : 'Grant Redline permission to edit this page. Your changes stay in this browser — nothing is sent anywhere.'
            }
            action={{ label: 'Enable Redline here', onClick: () => store.grantAccess() }}
          />
        </Show>
      </div>

      <DropOverlay visible={dragging()} />
      <Toasts />

      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip,.json,application/json"
        hidden
        onChange={onFileChange}
      />
    </PanelContext.Provider>
  );
}
