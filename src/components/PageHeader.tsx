import type { ReactNode } from "react";

/**
 * The only page header in the app: one row, title + page-scoped reading + actions.
 * The title is a plain element on purpose: antd's Typography scale must not leak into
 * the shared header geometry (see docs/ui-layout.md section 3).
 */
export function PageHeader({ title, meta, actions, children }: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Sticky-layer content rendered directly under the row (for example a selection bar). */
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-row">
        <div className="page-header-copy">
          <h2 className="page-header-title">{title}</h2>
          {meta ? <span className="page-header-meta">{meta}</span> : null}
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
