import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { Fragment, type ReactNode } from "react";

export type SubPagePathItem = { key: string; label: ReactNode; onClick?: () => void };

/**
 * The only second-level page bar: back target + real path + actions for this level.
 * It replaces the page header, it does not stack under it. See docs/ui-layout.md section 4.
 */
export function SubPageBar({ backLabel, onBack, items, actions, label, children }: {
  backLabel: string;
  onBack: () => void;
  items: SubPagePathItem[];
  actions?: ReactNode;
  label?: string;
  /** Sticky-layer content rendered directly under the bar (for example a selection bar). */
  children?: ReactNode;
}) {
  return (
    <header className="subpage-bar">
      <div className="subpage-bar-row">
        <div className="subpage-bar-main">
          <Button
            type="text"
            className="subpage-back"
            icon={<ArrowLeftOutlined />}
            aria-label={backLabel}
            title={backLabel}
            onClick={onBack}
          />
          <nav className="subpage-path" aria-label={label ?? backLabel}>
            {items.map((item, index) => (
              <Fragment key={item.key}>
                {index > 0 ? <span className="subpage-path-separator" aria-hidden="true">/</span> : null}
                {item.onClick
                  ? <button type="button" className="subpage-path-button" onClick={item.onClick}>{item.label}</button>
                  : <span className="subpage-path-current" aria-current="page">{item.label}</span>}
              </Fragment>
            ))}
          </nav>
        </div>
        {actions ? <div className="subpage-bar-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
