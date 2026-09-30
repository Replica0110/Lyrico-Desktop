<p align="center">
  <img src="./app-icon.png" width="96" height="96" alt="Lyrico Desktop 图标">
</p>

<h1 align="center">Lyrico Desktop</h1>

<p align="center">
  面向 Windows 的本地音乐标签编辑与歌词管理工具。<br>
  A local-first music tag editor and lyrics manager for Windows.
</p>

> [!WARNING]
> 当前版本为 `0.1.0`，仍在积极开发。批量修改和重命名前请保留音乐文件备份；当前打包目标仅配置了 Windows NSIS。

## 功能概览

- **本地音乐库**：手动添加音乐文件夹，扫描后按歌曲、专辑、艺术家和文件夹浏览；支持局部搜索与多选。
- **标签编辑**：编辑标题、艺术家、专辑、专辑艺术家、音轨、碟号、年份、流派、创作信息、评分、注释、歌词、封面和 ReplayGain 等字段。
- **歌词处理**：统一的 Rust 歌词管线可识别和转换普通 LRC、逐字 LRC、增强 LRC 与 TTML，并处理翻译、罗马音、空行和简繁转换。
- **插件源**：导入、启用、配置和卸载 Lyrico 搜索源插件；当前运行时支持歌曲搜索、歌词获取和封面搜索。
- **后台批处理**：提供标签匹配、批量编辑、歌词格式化、文件重命名、ReplayGain 曲目分析，以及歌词和封面导出；任务可显示进度并取消。
- **本地持久化**：音乐库摘要和任务数据保存到 SQLite，应用设置保存到 JSON；非法文件名字符映射等配置会跨重启保留。

当前扫描识别的音频扩展名包括：`mp3`、`flac`、`m4a`、`mp4`、`ogg`、`opus`、`wav`、`aiff` 和 `aif`。不同容器可写入的标签字段由底层格式本身和 [TagLib](https://github.com/taglib/taglib) 支持范围共同决定。

## 插件系统

在线搜索不硬编码在应用本体中，而是由 JavaScript 插件提供，与移动端插件通用。


桌面端支持插件协议 API1–API5（Platform Host API 4）。API4 可提供不依赖歌曲搜索的独立歌词候选和封面候选，标签、歌词、封面入口可分别启用。插件开发与格式说明请阅读 [Lyrico 插件文档](https://replica0110.github.io/Lyrico/plugins/overview.html)，插件仓库见 [Lyrico-Plugins](https://github.com/Replica0110/Lyrico-Plugins)。第三方插件能够执行网络请求并读取其配置，只应安装可信来源的插件。

## 技术架构

```text
React 19 + Ant Design 6
          │
          │ Tauri commands / events
          ▼
Rust: library · audio tags · lyrics · plugins · batch runner
          │
          ├── SQLite: music library and batch task data
          ├── JSON: desktop preferences
          └── Local audio files and installed plugins
```

主要技术：

- [Tauri 2](https://v2.tauri.app/)：桌面窗口、IPC、原生文件对话框和 Windows 打包。
- [React](https://react.dev/) + [Ant Design](https://ant.design/)：桌面界面与交互。
- [TagLib](https://github.com/taglib/taglib)：唯一的音频标签读写引擎，通过 Git 子模块集成并静态链接。
- [rusqlite](https://github.com/rusqlite/rusqlite)：本地音乐库与任务数据。
- [rquickjs](https://github.com/DelSkayn/rquickjs)：搜索源插件运行时。
- [ebur128](https://crates.io/crates/ebur128) + [Symphonia](https://github.com/pdeljanov/Symphonia)：ReplayGain 音频分析。

## 标签与文件写入边界

所有标准字段、自定义字段、歌词、ReplayGain、评分和封面都经过 `audio` 业务接口，使用同一个 TagLib 后端。C++ 桥接层负责格式适配与原生资源，Rust 桥接层负责句柄生命周期和结构化数据传输，命令层不直接调用原生标签 API。

桥接层与移动端一致，使用 `properties()` / `setProperties()` 和 `complexProperties("PICTURE")` / `setComplexProperties()`，容器细节交给 TagLib。评分在业务层换算为通用 `RATING` 属性（0–100），不另外操作原始 POPM 帧。

手工保存提交一次完整编辑；批量编辑仅提交明确修改的字段。标签写入在同文件锁下处理同目录临时副本，保存与读取校验成功后再替换原文件。未知标签和格式私有帧保留，封面编辑只替换前封面，原始只读文件会返回错误。未修改的文件不重写。

TagLib 源码位于 `src-tauri/native/taglib-src`。与移动端一致，子模块没有版本标签约束；CMake 只编译已初始化的本地源码，不负责联网下载。首次克隆或切换主仓库提交后运行：

```powershell
git submodule update --init --recursive
```

主动跟进上游时运行以下命令，并将子模块提交变化与应用改动一并审查：

```powershell
git submodule update --remote --recursive src-tauri/native/taglib-src
```

主仓库仍记录子模块提交，这是 Git 子模块的标准机制。原始 ADTS `.aac` 不提供可编辑的 TagLib 标签容器，因此不再作为可编辑文件扫描；AAC 编码的 `.m4a` / `.mp4` 仍然支持。

升级后重新扫描已有音乐库，以填充原先未保存的歌词搜索数据。歌词搜索和曲目摘要共用同一索引更新流程。

## 本地开发

### 环境要求

- Windows 10/11
- Node.js `20.19+` 或 `22.12+`
- Rust stable（MSVC toolchain）
- Microsoft C++ Build Tools 与 WebView2
- CMake 3.20+、Ninja 与 Git（原生 TagLib 构建）

Windows 原生依赖的安装方式以 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows) 为准。

### 启动应用

```powershell
git clone https://github.com/Replica0110/Lyrico-Desktop.git
cd Lyrico-Desktop
git submodule update --init --recursive
npm ci
npm run tauri dev
```

只启动浏览器中的前端预览可运行 `npm run dev`，但文件对话框、音频读写、数据库和插件等能力依赖 Tauri bridge，不能在普通浏览器中完整工作。

### 检查与测试

```powershell
npx tsc --noEmit
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

### 构建安装包

```powershell
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。


## 开发状态与贡献

开发路线、已完成边界和验证记录集中在 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。提交问题时请附上 Windows 版本、相关音频格式、可复现步骤和错误信息；涉及音频文件时请使用可公开的测试副本。

项目的维护目标与移动端一致：优先解决可复现的本地音乐整理需求，保持核心交互清晰，并将平台相关的在线能力留给插件扩展。
