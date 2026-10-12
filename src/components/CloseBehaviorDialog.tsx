import { App, Modal, Radio, Space, Typography } from "antd";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function CloseBehaviorDialog({ open, onCancel, onConfirm }: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (toTray: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [toTray, setToTray] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function confirm() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await onConfirm(toTray);
    } catch (error) {
      message.error(String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <Modal
    title={t("common.closePrompt.title")}
    open={open}
    centered
    width={360}
    closable={!saving}
    keyboard={!saving}
    mask={{ closable: false }}
    confirmLoading={saving}
    cancelButtonProps={{ disabled: saving }}
    onCancel={onCancel}
    onOk={() => void confirm()}
  >
    <Space orientation="vertical" size="middle">
      <Radio.Group value={toTray} onChange={event => setToTray(event.target.value)} disabled={saving}>
        <Space orientation="vertical">
          <Radio value={true}>{t("common.closePrompt.tray")}</Radio>
          <Radio value={false}>{t("common.closePrompt.close")}</Radio>
        </Space>
      </Radio.Group>
      <Typography.Text type="secondary">{t("common.closePrompt.description")}</Typography.Text>
    </Space>
  </Modal>;
}
