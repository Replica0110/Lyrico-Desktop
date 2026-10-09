/**
 * The one progress bar. Both the global scan/replay-gain strips and in-panel progress use it,
 * so a bare percentage is never the only signal. See docs/ui-layout.md §5.
 *
 * `indeterminate` covers work that reports no meaningful percentage yet (for example a single
 * track analysis, which only reports 0 then 100): the track shows motion instead of an empty bar.
 */
export function ProgressBar({ percent, status = "active", indeterminate = false, className }: {
  percent: number;
  status?: "active" | "success" | "exception";
  indeterminate?: boolean;
  className?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  const pending = indeterminate && status === "active";
  return (
    <span
      className={`progress-bar is-${status}${pending ? " is-indeterminate" : ""}${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pending ? undefined : Math.round(value)}
    >
      <span className="progress-bar-fill" style={pending ? undefined : { width: `${value}%` }} />
    </span>
  );
}
