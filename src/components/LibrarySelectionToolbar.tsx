import { CloudSyncOutlined } from "@ant-design/icons";
import { Button, Space } from "antd";
import { useTranslation } from "react-i18next";

/**
 * The one selection bar. It lives in PageHeader children and only renders while the
 * selection holds data. See docs/ui-layout.md section 7.
 */
export function LibrarySelectionToolbar({ selectedCount, onOpenBatch, onClear, onSelectAll }: {
  selectedCount: number;
  onOpenBatch: () => void;
  onClear?: () => void;
  onSelectAll?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="selection-bar">
      <Space wrap>
        <span className="selection-bar-count">{t("selection.count", { count: selectedCount })}</span>
        {onSelectAll ? <Button type="text" size="small" onClick={onSelectAll}>{t("selection.selectAll")}</Button> : null}
        {onClear ? <Button type="text" size="small" disabled={!selectedCount} onClick={onClear}>{t("selection.clear")}</Button> : null}
      </Space>
      <Button type="primary" size="small" icon={<CloudSyncOutlined />} disabled={selectedCount === 0} onClick={onOpenBatch}>
        {t("selection.batch")}
      </Button>
    </div>
  );
}
