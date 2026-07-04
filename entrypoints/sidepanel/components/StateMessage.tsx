import { Show } from 'solid-js';

/** Centered empty/blocked/grant placeholder (the full-panel states). */
export default function StateMessage(props: {
  art: string;
  title: string;
  sub: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div class="state">
      <div class="state-art">{props.art}</div>
      <p class="state-title">{props.title}</p>
      <p class="state-sub">{props.sub}</p>
      <Show when={props.action}>
        <button class="primary" onClick={() => props.action!.onClick()}>
          {props.action!.label}
        </button>
      </Show>
    </div>
  );
}
