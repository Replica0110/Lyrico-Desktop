import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const readJson = (file) => JSON.parse(read(file));

const css = read("../App.css");
const shell = read("../components/Shell.tsx");
const settings = read("../pages/SettingsPage.tsx");
const songs = read("../pages/SongsPage.tsx");
const folders = read("../pages/FoldersPage.tsx");
const albums = read("../pages/AlbumsPage.tsx");
const artists = read("../pages/ArtistsPage.tsx");
const plugins = read("../pages/PluginsPage.tsx");
const tasks = read("../pages/TasksPage.tsx");
const libraryTable = read("../components/LibraryTable.tsx");
const sortableList = read("../components/SortableList.tsx");
const songDetails = read("../components/SongDetails.tsx");

const pageFiles = {
  SongsPage: songs,
  AlbumsPage: albums,
  ArtistsPage: artists,
  FoldersPage: folders,
  PluginsPage: plugins,
  TasksPage: tasks,
  SettingsPage: settings,
};

/** Changelog: docs/ui-layout.md section 10.1. These assertions are the design contract. */
describe("utility layout contract", () => {
  it("keeps batch lists continuous and progress in a stable footer", () => {
    const batchTable = read("../components/BatchTable.tsx");
    expect(batchTable).toContain("virtual pagination={false}");
    expect(batchTable).toContain("new ResizeObserver");
    expect(tasks).not.toContain("pageSize:");
    expect(tasks).toContain("<ProgressBar");
    expect(tasks).not.toContain("<Progress ");
    expect(tasks).toContain("tracksForTask");
    expect(tasks).toContain("SelectionMismatchContext");
    expect(css).toMatch(/\.batch-panel-footer \{[^}]*height: 64px/);
  });
  it("keeps one source for shell and page dimensions", () => {
    for (const token of [
      "--nav-width",
      "--nav-collapsed-width",
      "--header-height",
      "--bar-height",
      "--row-height",
      "--page-title-size",
    ]) {
      expect(css.match(new RegExp(`${token}:`, "g")), token).toHaveLength(1);
    }
    expect(shell).toContain("var(--nav-width)");
    expect(shell).toContain("var(--nav-collapsed-width)");
    expect(shell).toContain("aria-label={item.label}");
    expect(shell).toContain("aria-current=");
    expect(css).toContain("min-height: var(--header-height)");
    expect(css).toContain("min-height: var(--bar-height)");
  });

  it("keeps one page skeleton: every page uses PageHeader, second-level pages use SubPageBar", () => {
    for (const [name, source] of Object.entries(pageFiles)) {
      expect(source, name).toMatch(/<PageHeader\b/);
      expect(source, name).not.toMatch(/<header className="[a-z-]*(page-header|toolbar)/);
    }
    for (const name of ["AlbumsPage", "ArtistsPage", "FoldersPage"]) {
      expect(pageFiles[name], name).toMatch(/<SubPageBar\b/);
    }
    // Sub-pages replace the page header instead of stacking a second title row.
    expect(settings).not.toMatch(/<Card\b/);
  });

  it("keeps surfaces free of decorative gradients and blur", () => {
    expect(css).not.toMatch(/(?:linear|radial)-gradient|backdrop-filter|translateX\(2px\)/);
    expect(css).not.toMatch(/border-radius: (?:6|8|10|12|14)px/);
    // Hover may change colour or background, never geometry.
    expect(css).not.toMatch(/:hover[^{]*\{[^}]*transform:/);
  });

  it("keeps every table empty state on the shared text-only EmptyState", () => {
    for (const [name, source] of Object.entries(pageFiles)) {
      for (const match of source.matchAll(/emptyText:\s*([^\n,}]*)/g)) {
        expect(match[1], `${name}: ${match[0]}`).toContain("<");
      }
    }
    // Settings no longer contains a log table; diagnostics are saved to files.
    expect(settings).not.toContain("loadAppLogs");
    expect(settings).not.toContain("exportLogs");
    expect(settings).toContain("openLogsDirectory");
    expect(tasks).toContain("<NoSelectedSongs />");
  });

  it("keeps selection as data on the table instead of a page mode", () => {
    expect(libraryTable).not.toContain("selectionMode");
    expect(libraryTable).toContain("selection.selectAll");
    expect(libraryTable).toContain("onOpenTrackRef.current(track)");
    for (const [name, source] of Object.entries({ songs, folders })) {
      expect(source, name).not.toContain("selectionMode");
    }
    // Grid pages keep an explicit mode because a tile has no checkbox affordance.
    expect(albums).toContain("selectionMode");
    expect(artists).toContain("selectionMode");
  });

  it("keeps selection controls in the table and selected-song page without duplicate toolbars", () => {
    for (const [name, source] of Object.entries({ songs, folders, albums, artists })) {
      expect(source, name).not.toContain("LibrarySelectionToolbar");
    }
    expect(css).not.toContain(".selection-bar");
    const selectedPage = shell.slice(shell.indexOf("function SelectionPage"), shell.indexOf("function GlobalReplayGainProgress"));
    expect(selectedPage).toContain("<PageHeader");
    expect(selectedPage).not.toContain("<SubPageBar");
    expect(selectedPage).not.toContain("selection.batch");
    expect(shell).toContain('aria-current={selectionPageOpen ? "page" : undefined}');
  });

  it("keeps drag reordering on one shared dnd-kit implementation", () => {
    expect(sortableList).toContain("@dnd-kit/core");
    expect(sortableList).toContain("@dnd-kit/sortable");
    expect(sortableList).toContain("DragOverlay");
    expect(sortableList).not.toContain("onPointerDown=");
    for (const name of ["SettingsPage", "PluginsPage"]) {
      expect(pageFiles[name], name).toContain("<SortableList");
    }
  });

  it("keeps composite field groups and progress on shared components", () => {
    expect(songDetails).toContain("<ProgressBar");
    expect(songDetails).not.toMatch(/Progress[,\s].*from "antd"/);
    expect(songDetails).toContain('className="field-group"');
    expect(css).toContain(".field-group {");
    expect(css).toContain(".progress-bar {");
    expect(css).toContain(".progress-bar.is-indeterminate");
  });

  it("drops descriptive subtitles and keeps actionable empty states", () => {
    const library = readJson("../i18n/locales/zh-CN/library.json");
    const pluginsLocale = readJson("../i18n/locales/zh-CN/plugins.json");
    for (const key of ["songs", "albums", "artists", "folders"]) {
      expect(library[key].description, key).toBeUndefined();
    }
    expect(pluginsLocale.sources.description).toBeUndefined();
    expect(songs).toContain('onChangeQuery("")');
    expect(songs).toContain("onAddFolders");
  });
});
