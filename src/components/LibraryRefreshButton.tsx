import { ReloadOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

export function LibraryRefreshButton({ disabled, onRefresh }: { disabled: boolean; onRefresh: () => void }) {
  const { t } = useTranslation();
  const label = t("songs.refreshLibrary");
  return <Tooltip title={label}>
    <Button icon={<ReloadOutlined />} aria-label={label} disabled={disabled} onClick={onRefresh} />
  </Tooltip>;
}
