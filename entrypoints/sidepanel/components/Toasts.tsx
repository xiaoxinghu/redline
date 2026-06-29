import { For } from 'solid-js';
import { usePanel } from '../store';

/** Transient bottom-center notifications. */
export default function Toasts() {
  const { toasts } = usePanel();
  return (
    <div class="toasts">
      <For each={toasts()}>
        {(t) => <div class={'toast' + (t.kind === 'err' ? ' err' : '')}>{t.message}</div>}
      </For>
    </div>
  );
}
