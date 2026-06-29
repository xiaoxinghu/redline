import { Show } from 'solid-js';
import type { Row } from '@/utils/types';
import { usePanel } from '../store';
import Diff from './Diff';

/** A single change: status badges, element identity, the diff/thumbnails, selector + context. */
export default function ChangeRow(props: { row: Row; current: boolean }) {
  const panel = usePanel();
  const row = () => props.row;
  const el = () => props.row.element || {};

  const tagLabel = () => `<${el().tag || '?'}>` + (el().componentHint ? ` · ${el().componentHint}` : '');

  return (
    <div
      class={'row' + (props.current ? '' : ' offpage')}
      onClick={() => { if (!props.current) panel.gotoChange(row()); }}
    >
      <div class="top">
        <Show when={row().status === 'warning'} fallback={
          <Show when={props.current}>
            <span class="badge ok">applied</span>
          </Show>
        }>
          <span
            class="badge miss"
            title="Saved edit couldn't be applied on this page (text changed or element gone)."
          >needs attention</span>
        </Show>

        <Show when={row().kind === 'image'}>
          <span class="badge img">image</span>
        </Show>

        <span class="tag">{tagLabel()}</span>

        <Show when={props.current && row().id}>
          <button
            class="locate"
            title="Scroll to this change on the page"
            onClick={(e) => { e.stopPropagation(); panel.locate(row().id!); }}
          >Locate ↧</button>
        </Show>
        <Show when={!props.current}>
          <button
            class="locate"
            title="Open this page and highlight the change"
            onClick={(e) => { e.stopPropagation(); panel.gotoChange(row()); }}
          >Go ↗</button>
        </Show>

        <button
          class="rowx"
          title="Remove this change"
          onClick={(e) => { e.stopPropagation(); panel.removeChange(row(), props.current); }}
        >✕</button>
      </div>

      <Show
        when={row().kind === 'image'}
        fallback={<div class="mini"><Diff original={row().original} edited={row().edited} /></div>}
      >
        <div class="mini img">
          <img class="thumb" alt="before" src={row().original || undefined} />
          <span class="arrow">→</span>
          <img class="thumb" alt="after" src={row().edited || undefined} />
        </div>
      </Show>

      <Show when={row().kind === 'image' && row().previewBlocked}>
        <div class="ctx warn">Preview blocked on the live site — saved & will be exported.</div>
      </Show>

      <div class="sel">{el().selector || el().domPath || '(no selector)'}</div>

      <Show when={el().context && el().context!.nearestHeading}>
        <div class="ctx">under: {el().context!.nearestHeading}</div>
      </Show>
    </div>
  );
}
