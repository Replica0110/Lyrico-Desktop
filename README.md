# Lyrico Desktop

> 面向 Windows 的本地音乐标签编辑与歌词管理工具

Lyrico Desktop 是 [Lyrico](https://github.com/Replica0110/Lyrico) 的桌面端：整理本地音乐库、读写音频标签、处理歌词与封面。所有读写都在本机完成，在线搜索交给插件，插件与移动端通用。

## 功能

- **音乐库**：添加本地文件夹并扫描，按歌曲、专辑、艺术家、文件夹浏览和搜索，支持多选。
- **标签编辑**：标题、艺术家、专辑、专辑艺术家、音轨/碟号、年份、流派、创作信息、评分、注释、自定义标签、歌词、封面、ReplayGain。
- **歌词**：识别普通 LRC、逐字 LRC、增强 LRC 和 TTML，处理翻译、罗马音、空行与简繁转换。
- **批处理**：标签匹配、批量编辑、歌词格式化、重命名、ReplayGain 分析、歌词与封面导出；可查看进度、可取消。
- **插件**：导入、启用、配置、卸载搜索源插件并调整优先级，标签/歌词/封面入口分别可开关。

扫描的扩展名：`mp3`、`flac`、`m4a`、`mp4`、`ogg`、`opus`、`wav`、`aiff`、`aif`。能写入哪些字段由容器格式和 [TagLib](https://github.com/taglib/taglib) 的支持范围决定。

## 插件

在线搜索不内置在应用里，由 JavaScript 插件提供（插件 API 1–5，宿主 API 4）。

- [插件文档](https://replica0110.github.io/Lyrico/plugins/overview.html)
- [插件仓库](https://github.com/Replica0110/Lyrico-Plugins)

插件能发起网络请求并读取自己的配置，只安装可信来源的插件。

## 构建

需要 Windows 10/11、Node.js 20.19+ 或 22.12+、Rust stable（MSVC）、Microsoft C++ Build Tools、WebView2，以及 CMake 3.20+、Ninja、Git（用于编译原生 TagLib）。系统依赖以 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows) 为准。

```powershell
git clone https://github.com/Replica0110/Lyrico-Desktop.git
cd Lyrico-Desktop
git submodule update --init --recursive
npm ci
npm run tauri dev
```

`npm run dev` 只在浏览器里跑前端；文件对话框、标签读写、数据库和插件都依赖 Tauri，浏览器中不可用。

打包与检查：

```powershell
npm run tauri build                                    # 产物在 src-tauri/target/release/bundle/
npx tsc --noEmit
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

## 使用

首次打开是空库：点「添加文件夹」选音乐目录，扫描后在歌曲、专辑、艺术家、文件夹四个视图里浏览。单击一行打开编辑抽屉；按住 Ctrl/Shift 或勾选首列复选框可以多选，选中后点「批量处理」。设置里能调整字段顺序、歌词行顺序、艺术家拆分规则和主题。

## 技术栈

- **Tauri 2**：窗口、IPC、原生文件对话框和 Windows 打包。
- **React 19 + Ant Design 6**：界面。
- **TagLib**：唯一的标签读写引擎，通过 Git 子模块（`src-tauri/native/taglib-src`）引入并静态链接。
- **rusqlite**：音乐库与批处理任务数据，保存在 `database/lyrico.sqlite3`。
- **rquickjs**：插件运行时。
- **ebur128 + Symphonia**：ReplayGain 分析。

应用设置保存在 `config/settings.json`。

## 写入行为

- 所有字段（含自定义标签、歌词、封面、ReplayGain）走同一个 TagLib 后端。未知标签和格式私有帧保留，封面只替换前封面。
- 写入先落在同目录临时副本上（同一把文件锁内），校验通过后再替换原文件；未修改的文件不重写，只读文件返回错误。
- 手工保存提交整个表单，批量编辑只提交被明确修改的字段。

## 已知限制

- 版本 `0.1.0`，仍在开发。批量修改和重命名前请保留音乐文件备份。
- 目前只配置了 Windows NSIS 打包目标。
- 原始 ADTS `.aac` 没有可编辑的标签容器，不参与扫描；AAC 编码的 `.m4a` / `.mp4` 正常支持。
- 子模块没有版本标签约束。升级后重新扫描一次音乐库，以补齐歌词搜索索引。

## 贡献

问题请提到 [Issues](https://github.com/Replica0110/Lyrico-Desktop/issues)，附上 Windows 版本、音频格式、复现步骤和报错信息；用到音频文件时请提供可公开的测试副本。PR 欢迎。

## 许可

本仓库目前没有附许可证文件（`UNLICENSED`）。随源码引入或静态链接的第三方组件遵循各自的许可证，其中 TagLib 为 LGPL-2.1 / MPL-2.0。
