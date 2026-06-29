/** Centered empty/blocked placeholder (the two full-panel states). */
export default function StateMessage(props: { art: string; title: string; sub: string }) {
  return (
    <div class="state">
      <div class="state-art">{props.art}</div>
      <p class="state-title">{props.title}</p>
      <p class="state-sub">{props.sub}</p>
    </div>
  );
}
