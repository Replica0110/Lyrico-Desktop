import { describe, expect, it } from "vitest";
import type { SourcePlugin } from "../app/types";
import { enabledPluginSources, pluginSources, reorderPluginState } from "./pluginSources";

const plugins = [
  { id: "a", name: "A", enabled: true, sourceStates: { metadata: { enabled: true, priority: 1 }, lyrics: { enabled: false, priority: 0 } } },
  { id: "b", name: "B", enabled: true, sourceStates: { metadata: { enabled: true, priority: 0 }, lyrics: { enabled: true, priority: 1 } } },
  { id: "c", name: "C", enabled: false, sourceStates: { lyrics: { enabled: true, priority: 2 } } },
] as SourcePlugin[];

describe("plugin category priorities", () => {
  it("uses a separate stable priority for each capability", () => {
    expect(pluginSources(plugins, "metadata").map(p => p.id)).toEqual(["b", "a"]);
    expect(pluginSources(plugins, "lyrics").map(p => p.id)).toEqual(["a", "b", "c"]);
    expect(plugins.map(p => p.id)).toEqual(["a", "b", "c"]);
  });
  it("does not expose disabled categories or a disabled master to matching", () => {
    expect(enabledPluginSources(plugins, "lyrics").map(p => p.id)).toEqual(["b"]);
    expect(enabledPluginSources(plugins, "covers")).toEqual([]);
  });
  it("commits the dropped category immediately without changing other priorities or enable flags", () => {
    const next = reorderPluginState(plugins, "metadata", ["a", "b"]);
    expect(pluginSources(next, "metadata").map(p => p.id)).toEqual(["a", "b"]);
    expect(pluginSources(next, "lyrics").map(p => p.id)).toEqual(["a", "b", "c"]);
    expect(next[0].sourceStates.metadata?.enabled).toBe(true);
    expect(next[0].sourceStates.lyrics).toBe(plugins[0].sourceStates.lyrics);
    expect(plugins[0].sourceStates.metadata?.priority).toBe(1);
  });
});
