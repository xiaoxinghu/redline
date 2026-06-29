import { For } from 'solid-js';
import { diffParts } from '@/utils/diff';

/** Inline word-level diff: unchanged text plus <ins>/<del> runs. */
export default function Diff(props: { original: string; edited: string }) {
  return (
    <For each={diffParts(props.original, props.edited)}>
      {(p) =>
        p.op === '=' ? <>{p.text}</> : p.op === '+' ? <ins>{p.text}</ins> : <del>{p.text}</del>
      }
    </For>
  );
}
