/**
 * The error bar.
 *
 * ── why it is its own component ──
 *
 * A failure that only lives in the console is a failure the user never
 * sees: "I clicked and nothing happened". This bar is the one place a
 * failure becomes visible — and it is a component of its own so it can be
 * tested on its own (the shell around it is a lot of moving parts).
 */
export function ErrorBar({
  message,
  onDismiss,
}: {
  /** The failure, already phrased for a human. */
  message: string | null;
  onDismiss: () => void;
}): JSX.Element | null {
  if (message === null) return null;
  return (
    <div className="shell-error" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>
        知道了
      </button>
    </div>
  );
}
