# Lyrico 界面施工图

这份文档是唯一的设计来源。**任何页面不得自定尺寸、自造页头、自造空态。** 需要新的视觉决定时，先改这里，再改 `src/App.css`，最后改页面。

基座：Ant Design 6 + `@ant-design/icons`，主题由 `src/app/App.tsx` 的 `ConfigProvider` 注入（`colorPrimary #1677ff`、`borderRadius 4`、`controlHeight 30`、`fontSize 13`）。明暗两套颜色走 `src/App.css` 的 `:root` / `[data-theme="dark"]` 变量。

---

## 1. Token（唯一来源：`src/App.css` 顶部）

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--nav-width` | 176px | 侧栏展开宽度 |
| `--nav-collapsed-width` | 56px | 侧栏折叠宽度 |
| `--page-padding` | 16px | 页头/状态栏左右内边距 |
| `--section-gap` | 12px | 区块间距 |
| `--surface-radius` | 4px | 唯一圆角，不允许 8/10/12px |
| `--page-title-size` | 20px | 页面标题（`h2`）字号 |
| `--header-height` | 44px | 页头行高 |
| `--bar-height` | 40px | 二级页面条 / 面板头 |
| `--control-height` | 30px | 控件高度（= antd `controlHeight`） |
| `--row-height` | 34px | 紧凑列表行最小高度 |
| `--list-gap` | 8px | 同一行内控件间距 |

硬规则：

- 圆角只用 4px（`--surface-radius`）；不允许 `border-radius: 6px/8px/10px/12px`。
- 不允许渐变、玻璃模糊（`backdrop-filter`）、彩色投影、悬浮位移（`hover` 时 `transform`）、emoji。
- 颜色只允许引用上面的语义变量或 antd token 变量（`var(--ant-color-primary)` 等）。只有三种情况可以写绝对值：图片/封面上的叠字、裁剪遮罩、跟随系统约定的窗口关闭按钮。
- 滚动条只定义一次（用 `--scrollbar-thumb*` 三个变量），不得再写一套硬编码的滚动条规则去覆盖它。
- 滚动条不得隐藏；长表格允许容器内横向滚动。

---

## 2. 页面骨架

所有页面共用一套骨架，`.page-viewport` 是唯一滚动容器（文档本身不滚动）：

```
┌ 标题栏 TitleBar ─────────────────────────────────┐
├ 侧栏 ┬ 页头 PageHeader ──────────────────────────┤
│      ├ 二级条 SubPageBar（仅二级页面）            │
│      ├ 内容区（页面自己滚动 / 表格内部滚动）       │
├──────┴ 状态栏 app-statusbar ────────────────────┤
```

- 页头与二级条**常驻可见**（`position: sticky; top: 0`），不在页面滚动时消失。
- 页头/二级条高度固定，内容不得改变它们的行高。
- 状态栏整体只出现一次「36 首歌曲，1 个文件夹」这类全局读数；页面内不再重复全局读数。

---

## 3. 页头 PageHeader（组件：`src/components/PageHeader.tsx`）

```tsx
<PageHeader title={t("songs.title")} meta={t("common.songCount", { count })} actions={<>…</>} />
```

结构固定为一行：

```
[ 歌曲   36 首歌曲 ]                                    [ 搜索框 ] [ 排序 ] [ 主操作 ]
   ↑ 20px  ↑ 12px 次要色，与标题基线对齐                    ↑ 右对齐，间距 8px
```

规则：

1. **只有一行**，高度 `--header-height`(44px)，底部 1px 分隔线，背景 `--bg-secondary`。页头下面不再有第二条说明行。
2. `meta` 只放**本页自己的读数**（`36 首歌曲`、`3 张专辑`、`1 个文件夹`、`2 个已安装`）。没有真实数字就不要 `meta`。
3. **禁止描述性副标题**。`浏览歌曲并编辑内嵌标签。` 这类句子删掉——名称已经说明了一切，删字测试过不了。
4. 右侧动作区 `gap: 8px`，顺序：搜索框 → 次级控件（排序/筛选）→ 主操作（`type="primary"`，永远在最右）。动作区是 `flex: 1 1 auto` 并右对齐：**窗口够宽时不许在页头内部换行**（实测 1180px 下歌曲页曾因为动作区被压缩成 449px 而折成两行、页头变成 68px）。
5. 页头里**不放**当前项的单个操作（重新读取、编辑当前项）。那些属于详情抽屉。
6. 页头按钮不超过 4 个。超出的收进「更多」下拉，或放回内容区。
7. 标题用**普通 `h2`**（`PageHeader` 内部实现），不要用 antd `Typography.Title`：它的 `h2` 字号是 28px，会盖掉 `--page-title-size`。页头几何是共享契约，不能被组件库的字阶污染。

---

## 4. 二级页面条 SubPageBar（组件：`src/components/SubPageBar.tsx`）

二级页面 = 从列表进入的下一层（文件夹内部、专辑详情、艺术家详情）。它**替换**整页，不是接在页头下面再加一行。

```tsx
<SubPageBar
  backLabel={t("common.back")}
  onBack={close}
  items={[{ key: "albums", label: t("albums.title"), onClick: backToRoot }, { key: id, label: album.title }]}
  actions={<>…</>}
/>
```

结构固定为一行（`--bar-height` 40px，底部 1px 分隔线）：

```
[ ← ]  所有文件夹 / Music / Live              [ 搜索 ] [ 排序 ] [ 上下文操作 ]
```

规则：

1. 左侧：返回按钮（`type="text"`、只有图标、`aria-label` = 返回目标）+ 路径。路径每一段可点，最后一段是纯文本（当前位置）。
2. 右侧：**只放作用于当前位置的操作**（搜索本层、排序本层、重新扫描本文件夹、隐藏、移除）。全局操作（添加文件夹、安装插件）留在列表页页头。
3. 二级页面**不再出现页面标题**。当前位置由路径表达；不要写「文件夹」标题 + 路径两处。
4. 二级页面的面包屑来源是数据（真实路径段），不是硬编码文案。

---

## 5. 面板与列表行

两级容器已经够用，不要三层卡片套卡片：

- **面板** `Panel`（组件：`src/components/Panel.tsx`）：1px 边框 + 4px 圆角 + 面板头（`--bar-height`、13px/600 标题 + 右侧 `extra`）+ 面板体。同一个页面最多用一个面板包两块内容。
- **列表行**：`min-height: var(--row-height)`，底部 1px 分隔线，**一行**放完名称 + 次要信息 + 右侧操作。名称与次要信息同行（`名称  路径…`），不要每个文件夹都堆两行。
- **行内操作**：默认只显示高频 1 个；其余在行 hover / 行内获得焦点时淡入（`.row-actions`）。破坏性操作（移除/卸载）必须走 `Popconfirm`。
- **空态** `EmptyState`（组件：`src/components/EmptyState.tsx`）：一句事实 + 一个可点的下一步动作。不画插画，不写鼓励语。
  - 数据库为空 → `还没有歌曲` + `添加文件夹`
  - 搜索无结果 → `没有匹配的歌曲` + `清除搜索`
  - 未选插件 → `请选择一个插件` 或 `还没有插件` + `安装插件`
- **字段组** `.field-group`：当一个字段带一串操作、或者几个字段其实是一份数据时（歌词、ReplayGain），用**一个**带边框的容器把「标签 + 操作 + 控件」包在一起。操作按钮放进组头（`.field-group-header`），**不许**让工具栏飘在无关字段旁边。
- **进度** `ProgressBar`（组件：`src/components/ProgressBar.tsx`）：全局扫描/回放增益条与面板内进度共用同一实现，**永远不要只显示一个裸百分比**。百分比未知时用 `indeterminate`（滑动动画）而不是空条。

---

## 6. 控件与文案

**控件选型**

| 需求 | 用什么 | 不用什么 |
| --- | --- | --- |
| 触发动作 | `Button` | 可点的 `div` / 假链接 |
| 二选一、分组切换 | `Segmented` / `Tabs` | 两个互斥按钮 |
| 多值输入 | `Select mode="tags"` / 可编辑输入 + 浏览按钮 | 「模式下拉 + 另一个输入框」 |
| 开关状态 | `Switch`（带 `已启用/已停用`） | 勾选框 |
| 排序字段 | `SortSelect`（唯一实现） | 页面自己写下拉 |
| 拖拽排序 | `SortableList`（唯一实现，dnd-kit） | 自研 pointer 排序 |

**数据优于模式。** 当界面出现「A 模式 / B 模式」时先问：这是不是同一份数据的两种取值？是就换成数据 + 一个输入。本次已经据此删掉了歌曲页的「多选模式」（见第 7 节）。

**文案（删字测试）**：每一句非数据文本都要问「删掉它，用户会不会少知道一件事？」不会就删。

| 禁止 | 例子 |
| --- | --- |
| `·` 串字段 | `24 位 · 有损` |
| 英文眉标 + 标语 | `WORKSPACE` / `把 X 和 Y 集中在一个轻量工作区里` |
| 常显解释段 | 页头下的功能简介 |
| 同一信息出现三次 | 页头 meta + 面板标题 + 状态栏 |
| 无单位数字 | 时长必须 `3:30`、大小必须带单位、数量必须带名词 |

---

## 7. 选择模型（本次重做的部分）

选择就是数据，不是模式。

- **表格类列表（歌曲页、文件夹内歌曲、专辑详情、艺术家详情）**：单击行 = **打开编辑抽屉**；首列是常显复选框（表头 = 全选，支持半选）；`Ctrl/⌘+单击` 切换选中、`Shift+单击` 连选。**没有「选择歌曲 / 退出多选」按钮。**
- 选中数量 > 0 时，内容区顶部出现选择条 `.selection-bar`：`已选择 3 首歌曲` + `全选` + `清空选择` + 主操作 `批量处理`。选择清空后自动消失。
- **网格类列表（专辑、艺术家）**保留显式「选择专辑 / 选择艺术家」模式——磁贴没有复选框位，模式在这里是合理的。
- 侧栏底部「已选歌曲」是唯一的全局入口，徽标显示数量。

---

## 8. 拖拽排序（dnd-kit）

`src/components/SortableList.tsx` 是唯一的排序实现，内部用 `@dnd-kit/core` + `@dnd-kit/sortable`：

- 竖向列表、`PointerSensor`（`activationConstraint: { distance: 4 }`）+ `KeyboardSensor`（`sortableKeyboardCoordinates`）。
- 拖动时用 `DragOverlay` 渲染跟手的浮层，原位置保留占位（`opacity` 降低），落位有过渡动画。
- 把手 `HolderOutlined` 可聚焦，`role="button"`，`aria-label` = `拖动排序：{{name}}`；方向键可排序；`Escape` 取消。
- 通过 `announcements` 或 live region 播报 `{{name}}，第 {{position}} 项，共 {{total}} 项`。
- 用到的三处：设置 › 歌词 › 歌词行顺序、设置 › 编辑字段 › 字段顺序、插件 › 已安装插件顺序。新增排序需求必须复用本组件。

---

## 9. 各页面目标布局

### 9.1 歌曲（`src/pages/SongsPage.tsx`）

```
[ 歌曲  36 首歌曲 ]                       [ 搜索 ] [ 排序 ] [ 添加文件夹 ]
（选中时）[ 已选择 3 首歌曲  全选 清空选择            批量处理 ]
┌ # ☑  歌曲            专辑        格式   时长   修改时间 ┐
```

- 首列宽度 44px，表头是全选复选框。
- 单击行打开编辑抽屉；不再有「编辑标签」「选择歌曲」「重新读取」页头按钮（重新读取在抽屉里）。
- 空库空态给「添加文件夹」；搜索无结果给「清除搜索」。

### 9.2 文件夹（`src/pages/FoldersPage.tsx`）

列表页：

```
[ 文件夹  1 个文件夹 ]                    [ 搜索文件夹 ] [ 排序 ] [ 添加文件夹 ]
📁 Music    C:/Music                                     36 首歌曲   ↻ 👁 🗑
```

- 文件夹行**一行**：图标 + 名称 + 路径（次要色、超出省略）+ 曲目数 + 行内操作（hover 淡入）。
- 点击行进入文件夹（二级页面）。

二级页面（进入文件夹后整页替换）：

```
[ ← ]  所有文件夹 / Music                 [ 搜索歌曲 ] [ ↻ ] [ 👁 ] [ 🗑 ]
      （表格：与歌曲页同一套 LibraryTable）
```

- 顶部**只有这一行**：返回 + 真实路径 + 本层操作。不再有「文件夹」标题占一行、面包屑再占一行。
- 搜索框只作用于当前文件夹的歌；排序交给表头（`LibraryTable` 内部排序）。
- 目录错误用 `Alert type="error"` 放在条下方。

### 9.3 插件（`src/pages/PluginsPage.tsx`）

```
[ 插件   2 个已安装 ]                                       [ 安装插件(primary) ]
┌ 已安装 ─────────┬──────────────────────────────────────────────┐
│ ⣿ [icon] 插件 A  │  [icon] 插件 A  v1.2.0      [启用 Switch] [卸载] │
│           标签   │  插件自述（真实数据，来自清单）                  │
│ ⣿ [icon] 插件 B  │  [能力标签] [能力标签] Plugin API 5 Host API ≥ 5 │
│           歌词   │  安装于 2026/9/1   更新于 2026/10/1             │
│                 │  ┌ 配置 | 清单 ┐                                │
│                 │  │ 表单 …                          [ 保存 ]      │
└─────────────────┴──────────────────────────────────────────────┘
```

- 左栏固定 260px（窄窗收窄）：面板头 `已安装`，下面是 `SortableList`（可拖拽调优先级）。每行**两行**放「名称 / 能力摘要」，名称占满整行宽度；`<=900px` 时隐藏能力摘要，保证名称不被截断（实测单行放不下，1180px 时名称已被截成 `MusicBrain...`，720px 时只剩 `Mu...`）。
- 右栏自适应：详情。头部一行放图标 + 名称 + 版本 + 启用开关 + 卸载；正文放插件自述、能力与 API 标签、安装与更新时间；再下面 `Tabs`（配置 / 清单）。
- **整页只有一个外框**：`.plugin-layout` 是唯一边框容器，左栏 `Panel` 去掉自身边框、用 `border-inline-end` 当竖分隔。不要再出现两块浮动卡片。
- 保存按钮放在配置区末尾并且**吸底**（`position: sticky; bottom: 0`，贴在 `.plugin-detail-body` 的滚动区底部），只在配置有改动时（`dirty`）可点。多字段插件不允许把主操作顶出首屏。
- 未安装任何插件：整页只给一个空态（`还没有插件` + `安装插件`），不要左空 Panel + 右空卡片两个空态。
- 删掉页头下的 `安装并配置 API v5 插件…` 说明句。

### 9.4 专辑 / 艺术家

- 列表页用 `PageHeader`：`专辑` + `3 张专辑`，右侧 `搜索` `排序` `选择专辑`。
- 网格磁贴保持现状；选中态用 `.collection-select-indicator`。
- 详情二级页面用 `SubPageBar`（返回 + `专辑 / 测试专辑`），下面接紧凑摘要行（封面 56px + 标题 + 艺术家 + `34 首曲目 119:00`），再接歌曲表格。
- 详情页的歌曲表与歌曲页同一套行为（单击行 = 编辑）。

### 9.5 批处理（`src/pages/TasksPage.tsx`）

- 页头 `PageHeader`：`批处理` + 右侧 `已选择 N 首歌曲` + `选择歌曲`。
- 操作栏按语义分组（匹配 / 编辑 / 导出 / 音频），组间用 1px 竖线分隔，同一行内按钮等宽等距；不再出现无分组的两行按钮。

### 9.6 设置（`src/pages/SettingsPage.tsx`）

- 页头只有 `PageHeader`（标题 `设置`，无 meta，无动作）。
- 保持左侧分类导航 + 平铺表单，不用卡片；每个设置项一行：标题 + 说明（hint）+ 右侧控件。
- 拖拽顺序编辑器复用 `SortableList`。

**编辑字段排序按「块」而不是按字段**（与移动端 `lyrico` 的 `EditFieldBlock` 同一模型）：

- ReplayGain 的 5 个值是**一次测量**，不是 5 个独立字段 → 它们永远相邻成一组，拖动时整块移动；排序只在块之间发生。
- 存储层由 `src/domain/editFieldSettings.ts` 的 `toEditFieldBlocks` / `flattenEditFieldBlocks` 保证：任何来源的字段顺序在读取时都会被折叠成块，所以**被打散的历史数据也会被拉回相邻**。
- 主列表里该块**只占一行**：`回放增益` + 「组」标记（可点，打开弹窗）+ 一个总开关（一次开关整组）。成员不在列表里展开。
- 点击这一行打开 **弹窗**（`Modal`，对应移动端的底部弹窗）管理成员：一行提示 `拖动调整组内顺序，开关控制字段显隐。`，下面是成员列表——每个成员可拖拽排序（`SortableList`）并带独立显示开关。
- 组内排序由 `withEditFieldBlockMembers` 写回：只替换该块的成员顺序，块的位置不变；未知键忽略，漏掉的成员保留在末尾。

---

## 10. 验收契约

### 10.1 机器契约（`src/app/layoutContract.test.mjs`，必须通过）

1. 尺寸单一来源：`--nav-width`、`--nav-collapsed-width`、`--header-height`、`--bar-height`、`--row-height`、`--page-title-size` 在 CSS 中各定义一次，且被组件引用。
2. 页面骨架单一来源：每个页面文件都使用 `PageHeader`；二级页面使用 `SubPageBar`；不出现自写 `<header className="...-page-header"`。
3. 禁用项：CSS 中无 `gradient` / `backdrop-filter`；无 `border-radius: 8|10|12|14px`；无 `hover` 位移。
4. 选择模型：`songs`/`folders` 源文件中不出现 `selectionMode`；`LibraryTable` 首列渲染 `Checkbox`（表头 = 全选/半选）。
5. 拖拽单一来源：`SortableList` 引入 `@dnd-kit` 且使用 `DragOverlay`，页面不自行实现排序。
6. 无描述性副标题：locale 中 `songs.description` / `albums.description` / `artists.description` / `folders.description` / `sources.description` 已删除。
7. 空态：不出现 antd 的 `Empty` 插画（`Table.locale.emptyText` 也必须传 `EmptyState`，不能传裸字符串）。

### 10.2 运行时验收（Playwright，`scripts/ui-browser-*.cjs`）

- 7 页 × {720×520, 1180×760} × {light, dark} = 28 张主截图，外加文件夹/专辑两个二级页面 × 2 窗口 × 2 主题 = 8 张；文档水平/垂直溢出、页面水平溢出均为 0；无 `pageerror`；可见交互元素无一超出页面视口左右边界。
- 跨页同名元素逐项相等：**两种窗口下** `.page-header-row` 渲染高度=44px（不是只看 CSS 常量）、`.page-header h2` 字号=20px、`.page-header-actions` 间距=8px、`.app-statusbar` 左内边距=16px；二级条行高=40px。
- 空库态：歌曲/文件夹/插件三页**各只有一个主按钮**（在空态里），且无 antd 插画。
- 主流程以真实数据走通并记录点击次数：
  1. 歌曲页单击一行 → 编辑抽屉打开（1 次点击）。
  2. 抽屉里改标题 → 保存 → 页面不白屏、标题真的落库（2 次点击）。
  3. 歌曲页勾选 2 行 → 选择条出现 → `批量处理` 跳到批处理页（3 次点击）。
  4. 文件夹页进入文件夹 → 二级条同时可见返回、路径、本层操作；歌曲页遗留的选择在二级条内继续显示为选择条。
  5. 专辑磁贴 → 二级条 + 紧凑摘要行 + 歌曲表。
  6. 插件页：左栏 2 项可拖拽、右栏详情、保存按钮由 dirty 门控。
  7. 设置 › 歌词：聚焦把手 → 空格拾起 → 方向键移动 → 空格落下，顺序真的变化且有位置播报。
- 翻译键泄漏：遍历 7 个页面 + 设置 9 个分类 + 抽屉 3 个 Tab + 批处理 10 个操作 + 插件 2 个 Tab，可见文本中不出现任何 i18n key，无 i18next 缺键告警。
- 截图矩阵人工只查溢出、截断、错位、留白，不看整体观感。

### 10.3 独立复核

由另一个没有本次上下文的 agent 只读复核：给它源码、本文件、截图。报告分级（必须修 / 建议修 / 可接受），每条带文件行号与复现命令。阻断项修完必须复测。

---

## 11. 复现命令

先起前端（Tauri 的 IPC 用浏览器夹具替代，只验证布局与交互，不代表真实磁盘写入）：

```powershell
New-Item -ItemType Directory -Force output/playwright
npm run dev -- --host 127.0.0.1
npx --yes --package @playwright/cli playwright-cli --session layout open http://127.0.0.1:1420
npx --yes --package @playwright/cli playwright-cli --session layout run-code --filename scripts/ui-browser-setup.cjs
npx --yes --package @playwright/cli playwright-cli --session layout run-code --filename scripts/ui-browser-audit.cjs
npx --yes --package @playwright/cli playwright-cli --session layout run-code --filename scripts/ui-browser-flows.cjs
```

同一个 session 里连续跑多个 `run-code` 会保留上一轮的状态（比如抽屉还开着）。`audit` / `flows` 脚本开头都会 `page.reload()` 复位，新写脚本时也要这么做。

单元测试与构建：

```powershell
npm test
npm run build
```

---

## 12. 本轮验证（2026-10-08 第二轮）

统一了 7 个页面的页头骨架，重做文件夹二级页面顶部区、插件页两栏布局，恢复了歌曲页「单击行 = 编辑」，并用 dnd-kit 换掉自研拖拽。

**修掉的具体缺陷（都有前后数字）**

| 项 | 之前 | 之后 |
| --- | --- | --- |
| 页头标题字号 | `h2` 被 antd Typography 顶成 28px | 全部 20px（`PageHeader` 用普通 `h2`） |
| 页头高度 | 1180px 下歌曲/专辑/艺术家/文件夹 68px（动作区被压成 449px 后折行）；720px 下同样折行 | 两种窗口下 7 页全部 44px（搜索框 `flex: 1 1 160px` 先缩，动作区不折行） |
| 文件夹二级页面顶部 | 页头（含「添加文件夹」）+ 面包屑两行叠加 | 一行：返回 + 真实路径（逐段可点）+ 本层 3 个操作；二级条行高 40px（两种窗口实测） |
| 歌曲页多选 | 单击 = 进入多选，页头 6 个按钮 | 单击 = 打开编辑；首列常显复选框（表头半选可用）；页头 3 个按钮 |
| 选择模型 | `selectionMode` 贯穿 5 个页面 | 表格类列表用数据（`selectedPaths`）驱动选择条；网格（专辑/艺术家）保留显式模式 |
| 插件页 | 页头说明句 + 两块浮动卡片 + 左栏单行截断 | 单外框两栏；720px 下名称两行不截断；保存按钮吸底且由 dirty 门控；空态只有一个主按钮 |
| 拖拽排序 | 自研 pointer 排序，无跟手浮层 | dnd-kit + `DragOverlay` + 落位过渡 + 键盘排序与播报，只在落位提交一次 |
| 空态一致性 | 批处理 7 张表用 antd 插画 + 部分空态无下一步 | 全部换成纯文字 `EmptyState`，并补上「重新扫描文件夹 / 去选歌」等下一步动作 |
| 保存崩溃 | IPC 返回空值时 `setTracks` updater 抛错 → 整页空白 | 结果判空 + `AppErrorBoundary`（内外两层），实测降级为「操作失败」提示且页面不丢 |
| 死 CSS | `App.css` 唯一类名 252 个（相对 HEAD），大量 folder-/plugin-/selection-dialog- 规则无人引用 | 删除 175 条失效规则；唯一类名 199；`App.css` 40.3 KB → 33.6 KB |
| 死键 | 复核扫描出 134 个 i18n 叶子键无任何引用 | 已清理，并做全视图运行时扫描确认无 key 泄漏 |
| 硬编码颜色 | 侧栏选中态/暗色覆盖块/圆角用死值 | 全部并回 token；仅保留「图片上叠字」「裁剪遮罩」「Windows 关闭按钮」三处必要的绝对值 |

**证据**

- `npx tsc --noEmit`：0 错误。
- `npm test`：21 个文件、63 项测试通过（含重写的 6 项布局契约）。
- `npm run build`：成功。
- Playwright：28 张主矩阵截图 + 8 张二级页面截图，全部 0 溢出、0 裁切、0 `pageerror`；跨页页头几何逐项相等。
- 交互走查见 10.2，每条都记录了点击次数。

**未覆盖**

- 插件配置的动态表单只用了 1 个夹具插件（含 text/password/dropdown/switch/依赖项/markdown 六种字段），不代表所有插件的真实表单。
- 浏览器夹具是模拟 IPC，**不证明**真实磁盘写入、系统对话框、标签写盘。
- 720×520 是文档声明支持的最小窗口；更窄的窗口未纳入验收。
