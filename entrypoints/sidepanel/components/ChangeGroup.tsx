import { For, Show } from 'solid-js';
import type { Group } from '@/utils/types';
import ChangeRow from './ChangeRow';

/** A per-page group: a sticky header (path · count · "this page") plus its rows. */
export default function ChangeGroup(props: { group: Group }) {
  const g = () => props.group;
  return (
    <section class="group">
      <div class="group-head">
        <span class="group-path" title={g().title || undefined}>{g().path}</span>
        <span class="group-count">{g().rows.length}</span>
        <Show when={g().current}>
          <span class="group-here">this page</span>
        </Show>
      </div>
      <For each={g().rows}>
        {(row) => <ChangeRow row={row} current={g().current} />}
      </For>
    </section>
  );
}
