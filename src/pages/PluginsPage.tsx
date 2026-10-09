import { ApiOutlined, AppstoreAddOutlined, DeleteOutlined, SaveOutlined } from "@ant-design/icons";
import { Avatar, Button, Form, Input, InputNumber, Modal, Select, Switch, Tag, Tabs, Tooltip } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import type { PluginConfigField, PluginSourceKind, SourcePlugin } from "../app/types";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SortableList } from "../components/SortableList";
import { pluginSources } from "../data/pluginSources";
import { capabilityLabel } from "../data/pluginCatalog";
import { formatTimeValue } from "../utils/format";
import "./PluginsPage.css";

const pluginTypeTabs: PluginSourceKind[] = ["metadata", "lyrics", "covers"];

type PluginsPageProps = {
  mutationBusy: boolean;
  plugins: SourcePlugin[];
  onInstall: () => Promise<void>;
  onChangeEnabled: (pluginId: string, sourceKind: PluginSourceKind, enabled: boolean) => Promise<void>;
  onSaveConfig: (pluginId: string, config: Record<string, string>) => Promise<void>;
  onUninstall: (pluginId: string) => Promise<void>;
  onMoveOrder: (sourceKind: PluginSourceKind, pluginIds: string[]) => Promise<void>;
};

/**
 * Installed plugins: fixed list rail on the left (drag to change priority),
 * detail of the selected plugin on the right. See docs/ui-layout.md §9.3.
 */
export function PluginsPage({ mutationBusy, plugins, onInstall, onChangeEnabled, onSaveConfig, onUninstall, onMoveOrder }: PluginsPageProps) {
  const { t } = useTranslation();
  const [sourceKind, setSourceKind] = useState<PluginSourceKind>("metadata");
  const [detailTab, setDetailTab] = useState("configuration");
  const [uninstallTarget, setUninstallTarget] = useState<SourcePlugin>();
  const visiblePlugins = useMemo(() => pluginSources(plugins, sourceKind), [plugins, sourceKind]);
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [config, setConfig] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string>();
  const actionInFlight = useRef(false);

  const selectedPlugin = visiblePlugins.find((plugin) => plugin.id === selectedPluginId) ?? visiblePlugins[0];
  const selectedId = selectedPlugin?.id;

  useEffect(() => {
    if (!visiblePlugins.some((plugin) => plugin.id === selectedPluginId)) {
      setSelectedPluginId(visiblePlugins[0]?.id);
    }
  }, [visiblePlugins, selectedPluginId]);

  // Snapshot on entering or switching a plugin: it is both the form draft and the
  // dirty baseline. Keyed by id so a list refresh (install, enable, reorder) does
  // not silently wipe edits the user has not saved yet.
  useEffect(() => {
    const snapshot = { ...plugins.find((plugin) => plugin.id === selectedId)?.config };
    setConfig(snapshot);
    setBaseline(snapshot);
  }, [selectedId]);

  const manifest = useMemo(() => {
    if (!selectedPlugin) return "";
    const {
      sourceStates: _sourceStates,
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

  const dirty = useMemo(() => !sameConfig(config, baseline), [config, baseline]);

  // Action handlers already report their own failure through a message, so a
  // rejected action must not leave a dangling unhandled rejection here.
  async function runAction(key: string, action: () => Promise<void>) {
    if (mutationBusy || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction(key);
    try {
      await action();
    } catch {
      // reported by the owning handler
    } finally {
      actionInFlight.current = false;
      setBusyAction(undefined);
    }
  }

  function updateConfig(key: string, value: string) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function install() {
    return runAction("install", onInstall);
  }

  function saveConfig(pluginId: string) {
    return runAction("save", async () => {
      await onSaveConfig(pluginId, config);
      setBaseline(config);
    });
  }

  function renderDetail(plugin: SourcePlugin) {
    const fields = plugin.configFields.filter((field) => dependencyMatches(field.dependency, config));

    return (
      <section className="plugin-detail">
        <div className="plugin-detail-header">
          <PluginIcon plugin={plugin} size={32} />
          <span className="plugin-detail-name" title={plugin.name}>{plugin.name}</span>
          <Tag className="plugin-version">v{plugin.versionName}</Tag>
          {detailTab === "configuration" && fields.some(field => field.type !== "markdown") ? (
            <Button className="plugin-config-save" type="primary" icon={<SaveOutlined />}
              disabled={!dirty || mutationBusy || Boolean(busyAction)} loading={busyAction === "save"}
              onClick={() => void saveConfig(plugin.id)}>{t("common.save")}</Button>
          ) : null}
        </div>

        <div className="plugin-detail-body">
          {plugin.description ? <p className="plugin-description">{plugin.description}</p> : null}
          <div className="plugin-tags">
            {plugin.capabilities.map((capability) => <Tag key={capability}>{capabilityLabel(capability)}</Tag>)}
            <Tag>Plugin API {plugin.apiVersion}</Tag>
            <Tag>Host API ≥ {plugin.minHostApiVersion}</Tag>
          </div>
          <p className="plugin-timestamps">
            <span>{t("sources.installedAt", { value: formatTimeValue(plugin.installedAt) })}</span>
            <span>{t("sources.updatedAt", { value: formatTimeValue(plugin.updatedAt) })}</span>
          </p>

          <Tabs
            className="plugin-tabs"
            activeKey={detailTab}
            onChange={setDetailTab}
            items={[
              {
                key: "configuration",
                label: t("sources.configuration"),
                children: fields.length ? (
                  <Form layout="vertical" className="plugin-config-form" disabled={(mutationBusy || Boolean(busyAction))}>
                    {fields.map((field) => (
                      <ConfigField
                        key={field.key}
                        field={field}
                        value={config[field.key] ?? field.defaultValue ?? ""}
                        onChange={(value) => updateConfig(field.key, value)}
                      />
                    ))}

                  </Form>
                ) : <EmptyState description={t("sources.noConfiguration")} />,
              },
              { key: "manifest", label: t("sources.manifest"), children: <pre className="plugin-manifest">{manifest}</pre> },
            ]}
          />
        </div>
      </section>
    );
  }

  return (
    <div className="page-shell plugin-page">
      <PageHeader
        title={t("sources.title")}
        meta={t("sources.installedCount", { count: plugins.length })}
        actions={plugins.length ? (
          <Button
            type="primary"
            icon={<AppstoreAddOutlined />}
            loading={busyAction === "install"}
            disabled={(mutationBusy || Boolean(busyAction))}
            onClick={() => void install()}
          >
            {t("sources.install")}
          </Button>
        ) : undefined}
      />

      {plugins.length === 0 ? (
        <div className="page-body plugin-body plugin-body-empty">
          <EmptyState
            description={t("sources.none")}
            action={
              <Button type="primary" loading={busyAction === "install"} disabled={(mutationBusy || Boolean(busyAction))} onClick={() => void install()}>
                {t("sources.install")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="page-body plugin-body">
          <div className="plugin-layout">
            <Panel
              className="plugin-list-panel"
              bodyClassName="plugin-list-body"
            >
              <Tabs
                className="plugin-source-tabs"
                activeKey={sourceKind}
                onChange={key => setSourceKind(key as PluginSourceKind)}
                items={pluginTypeTabs.map(key => ({ key, label: t(`sources.kinds.${key}`), disabled: (mutationBusy || Boolean(busyAction)) }))}
              />
              {visiblePlugins.length === 0 ? <EmptyState description={t("sources.noneInCategory")} /> : null}
              <SortableList
                disabled={(mutationBusy || Boolean(busyAction))}
                items={visiblePlugins.map((plugin) => plugin.id)}
                label={t("sources.installed")}
                labelFor={(id) => plugins.find((plugin) => plugin.id === id)?.name ?? id}
                onChange={(ids) => { void runAction("order", () => onMoveOrder(sourceKind, ids)); }}
                renderItem={(id) => {
                  const plugin = plugins.find((item) => item.id === id);
                  if (!plugin) return null;
                  const active = selectedId === id;
                  return (
                    <div className={`plugin-item${active ? " is-active" : ""}`}>
                      <button
                        type="button"
                        className="plugin-item-select"
                        disabled={(mutationBusy || Boolean(busyAction))}
                        aria-current={active ? "true" : undefined}
                        onClick={() => setSelectedPluginId(id)}
                      >
                        <PluginIcon plugin={plugin} size={28} />
                        <span className="plugin-item-copy">
                          <span className="plugin-item-name" title={plugin.name}>{plugin.name}</span>
                          <span className="plugin-item-meta" title={plugin.author}>v{plugin.versionName}{plugin.author ? ` / ${plugin.author}` : ""}</span>
                        </span>
                      </button>
                      <div className="plugin-item-actions">
                        <Tooltip title={t(plugin.sourceStates[sourceKind]?.enabled ? "common.enabled" : "common.disabled")}>
                          <Switch
                            size="small"
                            checked={Boolean(plugin.sourceStates[sourceKind]?.enabled)}
                            loading={busyAction === `enabled:${id}`}
                            disabled={(mutationBusy || Boolean(busyAction))}
                            aria-label={t("sources.toggleEnabled", { name: plugin.name })}
                            onChange={(enabled) => void runAction(`enabled:${id}`, () => onChangeEnabled(id, sourceKind, enabled))}
                          />
                        </Tooltip>
                        <Tooltip title={t("sources.uninstall")}>
                          <Button size="small" danger type="text" icon={<DeleteOutlined />}
                            aria-label={t("sources.uninstallNamed", { name: plugin.name })}
                            disabled={(mutationBusy || Boolean(busyAction))} onClick={() => setUninstallTarget(plugin)} />
                        </Tooltip>
                      </div>
                    </div>
                  );
                }}
              />
            </Panel>

            {selectedPlugin ? renderDetail(selectedPlugin) : (
              <div className="plugin-detail plugin-detail-empty">
                <EmptyState description={t("sources.select")} />
              </div>
            )}
          </div>
        </div>
      )}
      <Modal centered open={Boolean(uninstallTarget)} title={t("sources.uninstallConfirm", { name: uninstallTarget?.name })}
        okText={t("sources.uninstall")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }}
        confirmLoading={busyAction === "uninstall"} onCancel={() => setUninstallTarget(undefined)}
        onOk={() => void runAction("uninstall", async () => {
          if (uninstallTarget) await onUninstall(uninstallTarget.id);
          setUninstallTarget(undefined);
        })}>
        {t("sources.uninstallDetail")}
      </Modal>
    </div>
  );
}

function PluginIcon({ plugin, size }: { plugin: SourcePlugin; size: number }) {
  return <Avatar shape="square" size={size} src={plugin.iconDataUrl} icon={<ApiOutlined />} />;
}

function ConfigField({ field, value, onChange }: { field: PluginConfigField; value: string; onChange: (value: string) => void }) {
  if (field.type === "markdown") {
    return (
      <section className="plugin-markdown">
        {field.title ? <span className="plugin-markdown-heading">{field.title}</span> : null}
        <div className="plugin-markdown-body">
          <ReactMarkdown skipHtml>{field.defaultValue || field.summary || ""}</ReactMarkdown>
        </div>
      </section>
    );
  }

  const controlId = `plugin-config-${field.key}`;
  let control;
  switch (field.type) {
    case "password":
      control = <Input.Password id={controlId} value={value} onChange={(event) => onChange(event.target.value)} />;
      break;
    case "number":
      control = <InputNumber id={controlId} value={value === "" ? null : Number(value)} onChange={(next) => onChange(next == null ? "" : String(next))} />;
      break;
    case "switch":
      control = <Switch id={controlId} checked={value === "true"} onChange={(next) => onChange(String(next))} />;
      break;
    case "dropdown":
      control = <Select id={controlId} value={value || undefined} options={field.options?.map((option) => ({ value: option.value, label: option.label }))} onChange={onChange} />;
      break;
    case "textarea":
      control = <Input.TextArea id={controlId} value={value} autoSize={{ minRows: 3, maxRows: 8 }} onChange={(event) => onChange(event.target.value)} />;
      break;
    default:
      control = <Input id={controlId} value={value} onChange={(event) => onChange(event.target.value)} />;
  }

  return (
    <Form.Item label={field.title} htmlFor={controlId} required={field.required} extra={field.summary}>
      {control}
    </Form.Item>
  );
}

function sameConfig(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? "") !== (right[key] ?? "")) return false;
  }
  return true;
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
