import { App as AntApp, Button, Checkbox, Flex, Form, Input, Select, Space, Switch, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtistSplitConfig } from "../app/types";
import { builtinArtistSeparators } from "../domain/library";
import {
  validateNoSplitRule,
  validateSeparatorRule,
  visibleBuiltinSeparatorIds,
  type RuleRejection,
} from "../domain/artistSplitRules";

const { Text } = Typography;

type RuleItem = { id: string; value: string; enabled: boolean };

/**
 * The one editable rule list, used by both "custom separators" and "no-split artists":
 * type a value and press Enter (or 添加) to append a row; a row can be edited in place,
 * switched off without deleting, or removed. Values are stored exactly as typed — a separator
 * such as " feat. " keeps its spaces — and every change goes through the shared validators.
 * See docs/ui-layout.md §9.6.
 */
function RuleListEditor({ items, ariaLabel, placeholder, compact = false, validate, onChange, onReject }: {
  items: RuleItem[];
  ariaLabel: string;
  placeholder: string;
  compact?: boolean;
  /** Mirrors the mobile validators: rejects empty / duplicate / duplicate-of-built-in values. */
  validate: (raw: string, editingId?: string) => RuleRejection | undefined;
  onChange: (items: RuleItem[]) => void;
  onReject: (reason: RuleRejection) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const add = () => {
    if (!draft.trim()) return;
    const reason = validate(draft);
    if (reason) {
      onReject(reason);
      return;
    }
    onChange([...items, { id: createId(), value: draft, enabled: true }]);
    setDraft("");
  };

  return (
    <div className={`artist-rule-list${compact ? " is-compact" : ""}`}>
      {items.map((item) => (
        <RuleRow
          key={item.id}
          item={item}
          ariaLabel={ariaLabel}
          onCommit={(value) => {
            const reason = validate(value, item.id);
            if (reason) {
              onReject(reason);
              return false;
            }
            onChange(items.map((rule) => (rule.id === item.id ? { ...rule, value } : rule)));
            return true;
          }}
          onToggle={(enabled) => onChange(items.map((rule) => (rule.id === item.id ? { ...rule, enabled } : rule)))}
          onRemove={() => onChange(items.filter((rule) => rule.id !== item.id))}
        />
      ))}
      <Flex gap={8}>
        <Input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onPressEnter={add} />
        <Button icon={<PlusOutlined />} disabled={!draft.trim()} onClick={add}>{t("common.add")}</Button>
      </Flex>
    </div>
  );
}

function RuleRow({ item, ariaLabel, onCommit, onToggle, onRemove }: {
  item: RuleItem;
  ariaLabel: string;
  onCommit: (value: string) => boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(item.value);
  useEffect(() => setDraft(item.value), [item.value]);
  const commit = () => {
    if (draft === item.value) return;
    if (!onCommit(draft)) setDraft(item.value);
  };
  return (
    <Flex align="center" gap={8}>
      <Input
        aria-label={ariaLabel}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onPressEnter={commit}
      />
      <Switch size="small" aria-label={item.value} checked={item.enabled} onChange={onToggle} />
      <Button type="text" danger icon={<DeleteOutlined />} aria-label={t("common.remove")} onClick={onRemove} />
    </Flex>
  );
}

export function ArtistSplitSettings({
  config,
  onChange,
}: {
  config: ArtistSplitConfig;
  onChange: (config: ArtistSplitConfig) => void;
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const enabledBuiltinSeparators = builtinArtistSeparators
    .filter((item) => !config.hiddenBuiltinSeparatorIds.includes(item.id))
    .filter((item) => config.builtinSeparatorOverrides[item.id] ?? item.defaultEnabled)
    .map((item) => item.id);

  const reportRejection = (reason: RuleRejection) => {
    message.warning(t(
      reason === "empty" ? "artistSplit.invalidEmpty"
        : reason === "duplicateBuiltin" ? "artistSplit.duplicateBuiltin"
          : "artistSplit.duplicateItem",
    ));
  };

  return (
    <Space orientation="vertical" size={20} className="full-width">
      <Form layout="vertical" className="artist-split-form">
        <Form.Item label={t("artistSplit.artistSeparator")} extra={t("artistSplit.artistSeparatorHint")}>
          <Select
            value={config.artistSeparator}
            onChange={(artistSeparator) => onChange({ ...config, artistSeparator })}
            options={["、", "/", ",", ";"].map((value) => ({ value, label: <Text code>{value}</Text> }))}
          />
        </Form.Item>
        <Form.Item label={t("artistSplit.enabled")} extra={t("artistSplit.enabledHint")}>
          <Switch checked={config.enabled} onChange={(enabled) => onChange({ ...config, enabled })} />
        </Form.Item>

        <Form.Item label={t("artistSplit.builtinSeparators")} extra={t("artistSplit.builtinSeparatorsHint")}>
          <Checkbox.Group
            value={enabledBuiltinSeparators}
            onChange={(values) => {
              const enabledIds = new Set(values.map(String));
              onChange({
                ...config,
                builtinSeparatorOverrides: Object.fromEntries(
                  builtinArtistSeparators.map((item) => [item.id, enabledIds.has(item.id)]),
                ),
              });
            }}
          >
            <Space wrap>
              {builtinArtistSeparators.map((item) => (
                <Checkbox key={item.id} value={item.id}>
                  <Text code>{item.displayName}</Text>
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
        </Form.Item>

        <Form.Item label={t("artistSplit.customSeparators")} extra={t("artistSplit.customSeparatorsHint")}>
          <RuleListEditor
            compact
            ariaLabel={t("artistSplit.customSeparators")}
            placeholder={t("artistSplit.customSeparatorsPlaceholder")}
            items={config.customSeparators.map((item) => ({ id: item.id, value: item.value, enabled: item.enabled }))}
            validate={(raw, editingId) => validateSeparatorRule(raw, config.customSeparators, {
              editingId,
              visibleBuiltinIds: visibleBuiltinSeparatorIds(config),
            })}
            onChange={(items) => onChange({
              ...config,
              customSeparators: items.map((item) => ({ id: item.id, value: item.value, enabled: item.enabled })),
            })}
            onReject={reportRejection}
          />
        </Form.Item>

        <Form.Item label={t("artistSplit.noSplit")} extra={t("artistSplit.customNoSplitHint")}>
          <RuleListEditor
            ariaLabel={t("artistSplit.noSplit")}
            placeholder={t("artistSplit.customNoSplitPlaceholder")}
            items={config.customNoSplitArtists.map((item) => ({ id: item.id, value: item.name, enabled: item.enabled }))}
            validate={(raw, editingId) => validateNoSplitRule(raw, config.customNoSplitArtists, editingId)}
            onChange={(items) => onChange({
              ...config,
              customNoSplitArtists: items.map((item) => ({ id: item.id, name: item.value, enabled: item.enabled })),
            })}
            onReject={reportRejection}
          />
        </Form.Item>
      </Form>
    </Space>
  );
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
