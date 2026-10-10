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
┌ 系统原生标题栏（WebView 外）──────────────────────┐
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
- **列表行**：`min-height: var(--row-height)`，底部 1px 分隔线，按字段对齐名称、次要信息和右侧操作。文件夹使用名称与路径两行，并列显示歌曲数、子目录数、扫描状态和扫描时间；歌曲沿用原有信息，选择单元格独立垂直居中。
- **行内操作**：默认只显示高频 1 个；其余在行 hover / 行内获得焦点时淡入（`.row-actions`）。破坏性操作（移除/卸载）必须使用居中 `Modal`。
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

- **表格类列表（歌曲页、文件夹内歌曲、专辑详情、艺术家详情）**：单击行 = **打开编辑抽屉**；首列是常显复选框（表头 = 全选，支持半选）；`Ctrl+单击` 切换选中、`Shift+单击` 连选。列表获得焦点后，方向键改选当前行，`Shift+方向键` 从锚点连选，`Ctrl+方向键` 只移动光标，`Ctrl+A` 全选当前列表，`Enter` 打开光标所在行。**没有「选择歌曲 / 退出多选」按钮。**
- 文件夹、专辑、艺术家的二级页面里，鼠标后退侧键与顶栏返回相同，回到上一级。弹窗开着时不响应。前进侧键不记历史
- 表头复选框负责全选与取消全选，行内复选框负责单项选择；选中后不再插入额外工具栏，页头和内容位置保持不变。
- **网格类列表（专辑、艺术家）**保留显式「选择专辑 / 选择艺术家」模式——磁贴没有复选框位，模式在这里是合理的。
- 侧栏底部「已选歌曲」显示数量，进入独立一级页面，使用 `PageHeader`，不带返回上级按钮。该页提供搜索、清空选择和单项移除；批处理统一从侧栏「批处理」进入。

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

- 文件夹行：图标 + 名称/路径两行 + 曲目数/子目录数 + 扫描状态/时间 + 行内操作。
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

- 设计、分类与逻辑尽可能对齐移动端 `PluginManagerScreen.kt`；仅展示标签、歌词、封面三个分类。内部兼容协议字段不作为额外用户分类。
- 左栏无“已安装”面板头；分类标签高度48px、字号14px。左栏常规宽320px，窄窗按280/250px收窄。
- 每个插件项至少88px高，显示32px图标、名称、版本与作者；第二行常显当前类型启用开关和卸载按钮。选择按钮与操作按钮同级，不嵌套button。
- 右栏仅放详情、配置与清单，不重复行内启停和卸载操作；配置有改动才可保存。
- 松手时同步更新顺序，后台保存，失败恢复之前的分类优先级。一次只执行一个写操作，保存期间禁用拖动、分类/插件切换及其他写操作，防止迟到响应覆盖新状态。
- 整页仅 `.plugin-layout` 外框，未安装插件时仅显示一个安装空态。

### 9.4 专辑 / 艺术家

- 列表页用 `PageHeader`：`专辑` + `3 张专辑`，右侧 `搜索` `排序` `选择专辑`。
- 网格磁贴保持现状；选中态用 `.collection-select-indicator`。
- 详情二级页面用 `SubPageBar`（返回 + `专辑 / 测试专辑`），下面接紧凑摘要行（封面 56px + 标题 + 艺术家 + `34 首曲目 119:00`），再接歌曲表格。
- 详情页的歌曲表与歌曲页同一套行为（单击行 = 编辑）。

### 9.5 批处理（`src/pages/TasksPage.tsx`）

- 页头复用 `PageHeader`，保留已选歌曲数与选择入口
- 二级栏使用 `Segmented` 切换处理歌曲与任务历史，操作使用按匹配、编辑、歌词与导出、音频与文件分组的 `Select`，避免按钮墙和历史挤占工作区
- `BatchTable` 与歌曲列表一样使用虚拟滚动，无分页；容器用 `ResizeObserver` 测量可用宽高，只有表格主体滚动，配置和主操作常驻，窄窗配置允许独立滚动
- 首屏按任务展示现有信息摘要与逐首处理状态，字段明细通过已有字段计数打开；回放增益合并为完整程度与单曲增益摘要，不铺开五列
- 运行时逐首进度与成功、跳过、失败、取消可筛选，读取失败提供刷新；请求不重叠，切换任务时丢弃旧请求
- 任务历史独占列表空间，类型、状态、时间均本地化；详情按状态筛选每首结果，展示失败原因、已修改字段、输出路径和回放增益，失败任务可重试
- 总进度复用 `ProgressBar`，主操作与进度在固定底部区，出现进度不改变列表位置
- 歌词与封面匹配只提供对应的覆盖开关，不打开字段配置；删除警告位于底部操作区左侧
- 编辑使用配置与预览两页，配置区仅一层滚动；字段沿用设置中的顺序和显隐，实际显示 `<keep>` 表示不修改，空值表示清空，撤销恢复 `<keep>`，支持从已选歌曲中取值；字段名标记已修改或将清空
- 单项进度与状态水平排列，保留固定高度；失败详情提供重试此项，历史保留重试失败项，重试沿用原任务配置且仅包含指定失败项

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

**「自定义分隔符」和「不拆分的艺术家」必须是同一套操作与校验**（对齐移动端 `ArtistSplitSettingsViewModel`）：

- 两处共用同一个行列表编辑器：`值 + 启停开关 + 删除`，下面一行是 `输入 + 添加`；回车等同于点「添加」。不要一边用 `Select mode="tags"` 的 chip、一边用输入框加按钮。
- 校验规则（`src/domain/artistSplitRules.ts`，两处共用）：
  - 空白 → 拒绝（`内容不能为空`）
  - 分隔符按 **trim 后原样比较**（大小写与内部空格都算不同，因为 ` feat. ` 这类分隔符自带空格），且只与**当前可见**的内置分隔符冲突时拒绝（隐藏或关闭的内置项不拦）
  - 不拆分艺术家按 `normalizedArtistKey`（trim + 折叠空格 + 小写）比较
  - **编辑已有行时同样校验**，并排除自身
- 存的是**用户原样输入的字符串**（空格保留），校验只决定"能不能存"，不改写内容。
- 被拒绝时给一条 toast（`该项已存在` / `该项已存在于内置列表` / `内容不能为空`），并保持原值不变，不静默丢弃。

---

## 10. 验收契约

### 10.1 布局检查清单（构建检查与手动走查）

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
  3. 歌曲页勾选 2 行 → 页头高度不变 → 侧栏「已选歌曲」打开独立一级页面，再从侧栏「批处理」进入任务页，选中歌曲继续保留。
  4. 文件夹页进入文件夹 → 二级条同时可见返回、路径、本层操作；歌曲页遗留的选择由表格复选框展示，无额外选择栏，表头复选框可全选和取消全选。
  5. 专辑磁贴 → 二级条 + 紧凑摘要行 + 歌曲表。
  6. 插件页：左栏 2 项可拖拽、右栏详情、保存按钮由 dirty 门控。
  7. 设置 › 歌词：聚焦把手 → 空格拾起 → 方向键移动 → 空格落下，顺序真的变化且有位置播报。
- 翻译键泄漏：遍历 7 个页面 + 设置 9 个分类 + 抽屉 3 个 Tab + 批处理 10 个操作 + 插件 2 个 Tab，可见文本中不出现任何 i18n key，无 i18next 缺键告警。
- 截图矩阵人工只查溢出、截断、错位、留白，不看整体观感。

### 10.3 独立复核

由另一个没有本次上下文的 agent 只读复核：给它源码、本文件、截图。报告分级（必须修 / 建议修 / 可接受），每条带文件行号与复现命令。阻断项修完必须复测。

---

## 11. 复现运行时验收

Tauri 的 IPC 由浏览器夹具替代（`scripts/ui-browser-setup.cjs`），只验证布局与交互，不代表真实磁盘写入。dev server 与构建命令见 [README](../README.md)。

```powershell
New-Item -ItemType Directory -Force output/playwright
npm run dev -- --host 127.0.0.1
npx --yes --package @playwright/cli playwright-cli --session layout open http://127.0.0.1:1420
npx --yes --package @playwright/cli playwright-cli --session layout run-code --filename scripts/ui-browser-setup.cjs
npx --yes --package @playwright/cli playwright-cli --session layout run-code --filename scripts/ui-browser-audit.cjs
npx --yes --package @playwright/cli playwright-cli --session layout run-code --filename scripts/ui-browser-flows.cjs
```

同一个 session 里连续跑多个 `run-code` 会保留上一轮状态（比如抽屉还开着）；`audit` / `flows` 开头都会 `page.reload()` 复位，新写脚本时也要这么做。截图写在 `output/playwright/`（不纳入 Git）。

**未覆盖**：插件动态表单只用了一个夹具插件；夹具是模拟 IPC，不证明真实磁盘写入、系统对话框或标签落盘；720×520 是声明支持的最小窗口，更窄的窗口不纳入验收。

## 12. 任务与反馈（2026-10-09）

- 窗口使用 Tauri 原生标题栏（`decorations: true`）；窗口按钮位于 WebView 之外，Modal、Drawer、Message、Notification 均使用正常内容区域，不为标题栏逐组件增加偏移。Message 距内容顶端 12px。参见 [Tauri WindowConfig](https://v2.tauri.app/reference/config/#windowconfig)。
- 原生窗口主题同步应用的浅色/深色设置；“跟随系统”通过 `setTheme(null)` 恢复系统主题，需启用 `core:window:allow-set-theme`。
- 状态栏固定 30px；全局扫描、回放增益和批任务摘要只占状态栏，不在页头插入进度条。点击摘要显示上方悬浮详情，回放增益可取消，批任务可跳转到批处理页。任务出现、结束都不改变内容区域几何。
- 短操作使用 Message；扫描及批任务完成使用右下角 Notification；部分失败/失败通知保留到手动关闭，并提供任务入口。相同终态事件只提醒一次。
- 卸载插件、删除歌曲、移除目录、删除历史使用居中 Modal，明确取消与危险确认按钮。
- 插件按标签、歌词、封面分别排序和启用，运行时选源沿用对应分类顺序。SortableContext 与实际 DOM 顺序保持一致，仅 onDragEnd 落盘；DragOverlay 使用独立展示节点。
- 歌曲虚拟列表单元格使用 flex 对齐，复选框中心与实际行中心一致；禁止根据测量结果反向调全局 paddingSM。
- 插件列表为紧凑行：拖动把手、图标、名称和版本作者、启用开关、卸载按钮同排；长名称允许换行。保存位于详情固定标题栏，配置区独立滚动，不叠加底部操作条。
- 元数据结果使用同一个居中确认窗口：封面和歌词并排，下方展示可选择的标签；一次应用选中数据到编辑草稿，随后由编辑器保存。每个媒体请求都校验当前歌曲和请求版本。
- 在线匹配的元数据、歌词、封面模式分别保留关键词、结果、分页和来源选择；编辑器页签切换也保留。关闭抽屉后清理会话，换歌重新开始。抽屉保留挂载到 `afterOpenChange(false)`，保证关闭动画完整。

结构参考：[VS Code 状态栏](https://code.visualstudio.com/api/ux-guidelines/status-bar)、[通知规范](https://code.visualstudio.com/api/ux-guidelines/notifications)；API 参考：[Ant Design Message](https://ant.design/components/message/)、[Notification](https://ant.design/components/notification/)、[dnd-kit sortable](https://dndkit.com/legacy/presets/sortable/overview/)。
