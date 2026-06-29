import { For } from 'solid-js';
import { usePanel } from '../store';
import ChangeGroup from './ChangeGroup';

/** The scrollable list of page groups for the current origin. */
export default function ChangeList() {
  const { groups } = usePanel();
  return (
    <main class="list">
      <For each={groups()}>{(group) => <ChangeGroup group={group} />}</For>
    </main>
  );
}
