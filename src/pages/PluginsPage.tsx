import { ApiOutlined, AppstoreAddOutlined, ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, SaveOutlined } from "@ant-design/icons";
import {
  Avatar,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Menu,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tabs,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { PluginConfigField, SourcePlugin } from "../app/types";
import { capabilityLabel } from "../data/pluginCatalog";
import { formatTimeValue } from "../utils/format";

const { Title, Text, Paragraph } = Typography;

type PluginsPageProps = {
  plugins: SourcePlugin[];
  onInstall: () => Promise<void>;
  onChangeEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  onSaveConfig: (pluginId: string, config: Record<string, string>) => Promise<void>;
  onUninstall: (pluginId: string) => Promise<void>;
  onMoveOrder: (pluginId: string, direction: "up" | "down") => Promise<void>;
};

export function PluginsPage({ plugins, onInstall, onChangeEnabled, onSaveConfig, onUninstall, onMoveOrder }: PluginsPageProps) {
  const { t } = useTranslation();
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string>();
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? plugins[0];
  const selectedIndex = selectedPlugin ? plugins.findIndex((plugin) => plugin.id === selectedPlugin.id) : -1;

  useEffect(() => {
    if (!selectedPluginId || !plugins.some((plugin) => plugin.id === selectedPluginId)) {
      setSelectedPluginId(plugins[0]?.id);
    }
  }, [plugins, selectedPluginId]);

  useEffect(() => {
    setConfig(selectedPlugin?.config ?? {});
  }, [selectedPlugin]);

  const manifest = useMemo(() => {
    if (!selectedPlugin) return "";
    const {
      enabled: _enabled,
      sortOrder: _sortOrder,
      installedAt: _installedAt,
      updatedAt: _updatedAt,
      pluginDir: _pluginDir,
      iconPath: _iconPath,
      iconDataUrl: _iconDataUrl,
      config: _config,
      ...pluginManifest
    } = selectedPlugin;
    return JSON.stringify(pluginManifest, null, 2);
  }, [selectedPlugin]);

  async function runAction(key: string, action: () => Promise<void>) {
    setBusyAction(key);
    try {
      await action();
    } finally {
      setBusyAction(undefined);
    }
  }

  function updateConfig(key: string, value: string) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="workspace page-stack">
      <Flex justify="space-between" align="start" gap={16} wrap>
        <div>
          <Title level={2}>{t("sources.title")}</Title>
          <Text type="secondary">{t("sources.description")}</Text>
        </div>
        <Button
          type="primary"
          icon={<AppstoreAddOutlined />}
          loading={busyAction === "install"}
          onClick={() => void runAction("install", onInstall)}
        >
          {t("sources.install")}
        </Button>
      </Flex>

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={8} xl={7}>
          <Card title={t("sources.installed")} styles={{ body: { padding: 8 } }}>
            {plugins.length ? (
              <Menu
                mode="inline"
                className="source-menu"
                selectedKeys={selectedPlugin ? [selectedPlugin.id] : []}
                onSelect={({ key }) => setSelectedPluginId(key)}
                items={plugins.map((plugin) => ({
                  key: plugin.id,
                  label: (
                    <Flex align="center" gap={12} className="source-plugin-menu-row">
                      <PluginIcon plugin={plugin} />
                      <Flex vertical className="source-plugin-menu-copy">
                        <Text strong ellipsis>{plugin.name}</Text>
                        <Text type="secondary" ellipsis>{plugin.capabilities.map(capabilityLabel).join(" · ") || t("sources.noCapabilities")}</Text>
                      </Flex>
                      <Tag className="source-plugin-state" color={plugin.enabled ? "success" : "default"}>{plugin.enabled ? t("common.enabled") : t("common.disabled")}</Tag>
                    </Flex>
                  ),
                }))}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("sources.none")} />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={16} xl={17}>
          {selectedPlugin ? (
            <Card
              title={
                <Space>
                  <PluginIcon plugin={selectedPlugin} />
                  <span>{selectedPlugin.name}</span>
                  <Tag>v{selectedPlugin.versionName}</Tag>
                </Space>
              }
              extra={
                <Space>
                  <Switch
                    checked={selectedPlugin.enabled}
                    loading={busyAction === "enabled"}
                    checkedChildren={t("common.enabled")}
                    unCheckedChildren={t("common.disabled")}
                    onChange={(enabled) => void runAction("enabled", () => onChangeEnabled(selectedPlugin.id, enabled))}
                  />
                  <Button
                    aria-label={t("sources.moveUp")}
                    icon={<ArrowUpOutlined />}
                    disabled={selectedIndex <= 0}
                    loading={busyAction === "order"}
                    onClick={() => void runAction("order", () => onMoveOrder(selectedPlugin.id, "up"))}
                  />
                  <Button
                    aria-label={t("sources.moveDown")}
                    icon={<ArrowDownOutlined />}
                    disabled={selectedIndex < 0 || selectedIndex >= plugins.length - 1}
                    loading={busyAction === "order"}
                    onClick={() => void runAction("order", () => onMoveOrder(selectedPlugin.id, "down"))}
                  />
                  <Popconfirm
                    title={t("sources.uninstallConfirm", { name: selectedPlugin.name })}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => runAction("uninstall", () => onUninstall(selectedPlugin.id))}
                  >
                    <Button danger icon={<DeleteOutlined />} loading={busyAction === "uninstall"}>{t("sources.uninstall")}</Button>
                  </Popconfirm>
                </Space>
              }
            >
              <Space orientation="vertical" size={20} className="full-width">
                {selectedPlugin.description ? <Paragraph type="secondary">{selectedPlugin.description}</Paragraph> : null}
                <Flex gap={8} wrap>
                  {selectedPlugin.capabilities.map((capability) => <Tag key={capability}>{capabilityLabel(capability)}</Tag>)}
                  <Tag>Plugin API {selectedPlugin.apiVersion}</Tag>
                  <Tag>Host API ≥ {selectedPlugin.minHostApiVersion}</Tag>
                </Flex>
                <Flex gap={16} wrap>
                  <Text type="secondary">{t("sources.installedAt", { value: formatTimeValue(selectedPlugin.installedAt) })}</Text>
                  <Text type="secondary">{t("sources.updatedAt", { value: formatTimeValue(selectedPlugin.updatedAt) })}</Text>
                </Flex>

                <Tabs
                  className="source-detail-tabs"
                  items={[
                    {
                      key: "configuration",
                      label: t("sources.configuration"),
                      children: selectedPlugin.configFields.length ? (
                        <Form layout="vertical" className="source-config-form">
                          {selectedPlugin.configFields
                            .filter((field) => dependencyMatches(field.dependency, config))
                            .map((field) => (
                              <ConfigField key={field.key} field={field} value={config[field.key] ?? field.defaultValue ?? ""} onChange={(value) => updateConfig(field.key, value)} />
                            ))}
                          <Button type="primary" icon={<SaveOutlined />} loading={busyAction === "save"} onClick={() => void runAction("save", () => onSaveConfig(selectedPlugin.id, config))}>
                            {t("common.save")}
                          </Button>
                        </Form>
                      ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("sources.noConfiguration")} />,
                    },
                    { key: "manifest", label: t("sources.manifest"), children: <pre className="code-preview">{manifest}</pre> },
                  ]}
                />
              </Space>
            </Card>
          ) : (
            <Card><Empty description={t("sources.select")} /></Card>
          )}
        </Col>
      </Row>
    </div>
  );
}

function PluginIcon({ plugin }: { plugin: SourcePlugin }) {
  return <Avatar shape="square" size={36} src={plugin.iconDataUrl} icon={<ApiOutlined />} />;
}

function ConfigField({ field, value, onChange }: { field: PluginConfigField; value: string; onChange: (value: string) => void }) {
  if (field.type === "markdown") {
    return (
      <section className="plugin-markdown-field">
        {field.title ? <Text strong className="plugin-markdown-title">{field.title}</Text> : null}
        <div className="plugin-markdown-content">
          <ReactMarkdown skipHtml>{field.defaultValue || field.summary || ""}</ReactMarkdown>
        </div>
      </section>
    );
  }

  let control;
  switch (field.type) {
    case "password":
      control = <Input.Password value={value} onChange={(event) => onChange(event.target.value)} />;
      break;
    case "number":
      control = <InputNumber value={value === "" ? null : Number(value)} className="full-width" onChange={(next) => onChange(next == null ? "" : String(next))} />;
      break;
    case "switch":
      control = <Switch checked={value === "true"} onChange={(next) => onChange(String(next))} />;
      break;
    case "dropdown":
      control = <Select value={value || undefined} options={field.options?.map((option) => ({ value: option.value, label: option.label }))} onChange={onChange} />;
      break;
    case "textarea":
      control = <Input.TextArea value={value} autoSize={{ minRows: 3, maxRows: 8 }} onChange={(event) => onChange(event.target.value)} />;
      break;
    default:
      control = <Input value={value} onChange={(event) => onChange(event.target.value)} />;
  }

  return (
    <Form.Item label={field.title} required={field.required} extra={field.summary}>
      {control}
    </Form.Item>
  );
}

function dependencyMatches(dependency: unknown, config: Record<string, string>): boolean {
  if (!dependency || typeof dependency !== "object") return true;
  const value = dependency as Record<string, unknown>;
  const match = value.match as { key?: unknown; value?: unknown } | undefined;
  if (match) return typeof match.key === "string" && config[match.key] === String(match.value ?? "");
  const and = value.and as { conditions?: unknown[] } | undefined;
  if (and) return Array.isArray(and.conditions) && and.conditions.every((condition) => dependencyMatches(condition, config));
  const or = value.or as { conditions?: unknown[] } | undefined;
  if (or) return Array.isArray(or.conditions) && or.conditions.some((condition) => dependencyMatches(condition, config));
  const not = value.not as { condition?: unknown } | undefined;
  if (not) return !dependencyMatches(not.condition, config);
  return false;
}
