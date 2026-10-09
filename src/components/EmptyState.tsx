import type { ReactNode } from "react";

/**
 * The only empty state: one factual line plus at most one next action.
 * No illustration, no encouragement. See docs/ui-layout.md section 5.
 */
export function EmptyState({ description, action }: { description: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-text">{description}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
