import { Show } from 'solid-js';

/** Full-surface overlay shown while dragging a bundle file over the panel. */
export default function DropOverlay(props: { visible: boolean }) {
  return (
    <Show when={props.visible}>
      <div class="drop">
        <div class="drop-box">
          Drop a <u>.redline-bundle.zip</u> (or <u>.redline-session.json</u>) to apply
        </div>
      </div>
    </Show>
  );
}
