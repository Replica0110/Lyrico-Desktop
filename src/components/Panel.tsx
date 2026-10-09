import type { ReactNode } from "react";

/**
 * One bordered surface with a fixed header row. See docs/ui-layout.md section 5.
 * Never nest a Panel inside a Panel.
 */
export function Panel({ title, extra, children, className, bodyClassName }: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      {title || extra ? (
        <header className="panel-header">
          <span className="panel-title">{title}</span>
          {extra ? <div className="panel-header-extra">{extra}</div> : null}
        </header>
      ) : null}
      <div className={`panel-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>{children}</div>
    </section>
  );
}
