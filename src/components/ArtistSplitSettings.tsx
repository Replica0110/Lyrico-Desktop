import { Button, Checkbox, Flex, Form, Input, Select, Space, Switch, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtistSplitConfig } from "../app/types";
import { builtinArtistSeparators } from "../domain/library";

const { Text } = Typography;

export function ArtistSplitSettings({
  config,
  onChange,
}: {
  config: ArtistSplitConfig;
  onChange: (config: ArtistSplitConfig) => void;
}) {
  const { t } = useTranslation();
  const enabledBuiltinSeparators = builtinArtistSeparators
    .filter((item) => !config.hiddenBuiltinSeparatorIds.includes(item.id))
    .filter((item) => config.builtinSeparatorOverrides[item.id] ?? item.defaultEnabled)
    .map((item) => item.id);
  const [artistName, setArtistName] = useState("");
  function addArtist() {
    const name = artistName.trim();
    if (!name || config.customNoSplitArtists.some(item => normalizeArtist(item.name) === normalizeArtist(name))) return;
    onChange({ ...config, customNoSplitArtists: [...config.customNoSplitArtists, { id: createId(), name, enabled: true }] });
    setArtistName("");
  }

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
          <Select
            mode="tags"
            value={config.customSeparators.filter((item) => item.enabled).map((item) => item.value)}
            placeholder={t("artistSplit.customSeparatorsPlaceholder")}
            onChange={(values) => {
              const normalizedValues = uniqueNonBlank(values, true).filter(
                (value) => !builtinArtistSeparators.some((item) => item.value.trim() === value.trim()),
              );
              onChange({
                ...config,
                customSeparators: normalizedValues.map((value) => {
                  const existing = config.customSeparators.find((item) => item.value.trim() === value.trim());
                  return existing ? { ...existing, enabled: true } : { id: createId(), value, enabled: true };
                }),
              });
            }}
          />
        </Form.Item>

        <Form.Item label={t("artistSplit.noSplit")} extra={t("artistSplit.customNoSplitHint")}>
          <div className="artist-rule-list">
            {config.customNoSplitArtists.map(item => <Flex key={item.id} align="center" gap={8}>
              <Input aria-label={t("artistSplit.noSplit")} value={item.name} onChange={event => onChange({ ...config, customNoSplitArtists: config.customNoSplitArtists.map(rule => rule.id === item.id ? { ...rule, name: event.target.value } : rule) })} />
              <Switch size="small" aria-label={item.name} checked={item.enabled} onChange={enabled => onChange({ ...config, customNoSplitArtists: config.customNoSplitArtists.map(rule => rule.id === item.id ? { ...rule, enabled } : rule) })} />
              <Button type="text" danger icon={<DeleteOutlined />} aria-label={t("common.remove")} onClick={() => onChange({ ...config, customNoSplitArtists: config.customNoSplitArtists.filter(rule => rule.id !== item.id) })} />
            </Flex>)}
            <Flex gap={8}><Input value={artistName} placeholder={t("artistSplit.customNoSplitPlaceholder")} onChange={event => setArtistName(event.target.value)} onPressEnter={addArtist} /><Button icon={<PlusOutlined />} disabled={!artistName.trim()} onClick={addArtist}>{t("common.add")}</Button></Flex>
          </div>
        </Form.Item>
      </Form>
    </Space>
  );
}

function uniqueNonBlank(values: string[], preserveWhitespace = false) {
  const result: string[] = [];
  for (const rawValue of values) {
    if (!rawValue.trim()) continue;
    const value = preserveWhitespace ? rawValue : rawValue.trim();
    if (!result.some((item) => normalizeArtist(item) === normalizeArtist(value))) result.push(value);
  }
  return result;
}

function normalizeArtist(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
