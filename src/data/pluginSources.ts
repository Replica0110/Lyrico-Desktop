import type { PluginSourceKind, SourcePlugin } from "../app/types";

export const pluginSourceKinds: PluginSourceKind[] = ["metadata", "lyrics", "covers", "aggregated"];

/** Every category has its own persisted priority and enable state. */
export function pluginSources(plugins: SourcePlugin[], kind: PluginSourceKind): SourcePlugin[] {
  return plugins.filter(plugin => Boolean(plugin.sourceStates?.[kind]))
    .sort((a, b) => (a.sourceStates[kind]?.priority ?? 0) - (b.sourceStates[kind]?.priority ?? 0)
      || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function enabledPluginSources(plugins: SourcePlugin[], kind: PluginSourceKind): SourcePlugin[] {
  return pluginSources(plugins, kind).filter(plugin => plugin.enabled && plugin.sourceStates[kind]?.enabled);
}

/** Update only the chosen category immediately; persistence follows the UI commit. */
export function reorderPluginState(plugins: SourcePlugin[], kind: PluginSourceKind, ids: string[]): SourcePlugin[] {
  const priorities = new Map(ids.map((id, index) => [id, index]));
  return plugins.map(plugin => {
    const state = plugin.sourceStates[kind];
    const priority = priorities.get(plugin.id);
    return state && priority !== undefined
      ? { ...plugin, sourceStates: { ...plugin.sourceStates, [kind]: { ...state, priority } } }
      : plugin;
  });
}
