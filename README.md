# Lyrico Desktop

Windows 音乐标签编辑与歌词管理工具，[Lyrico](https://github.com/Replica0110/Lyrico) 的桌面端。

## 功能

- 按歌曲、专辑、艺术家和文件夹浏览、搜索本地音乐
- 编辑音频标签、自定义字段、内嵌歌词和封面
- 转换普通 LRC、逐字 LRC、增强 LRC 与 TTML，整理翻译、罗马音和歌词行顺序
- 批量匹配标签、歌词和封面，编辑标签、重命名文件、导出歌词与封面
- 计算并写入 ReplayGain 单曲增益与峰值

支持扫描 MP3、FLAC、M4A、MP4、OGG、Opus、WAV、AIFF（含 `.aif`）。标签读写使用 [TagLib](https://github.com/taglib/taglib)，可编辑字段因文件格式而异。

## 使用

在「文件夹」页点击「添加文件夹」，选择音乐目录并扫描。打开歌曲可编辑标签，选中多首歌曲后点击「批量处理」。

在线匹配需要在「插件」页安装并启用搜索源插件，与 Android 端共用 [插件仓库](https://github.com/Replica0110/Lyrico-Plugins)。插件开发见 [插件文档](https://replica0110.github.io/Lyrico/plugins/overview.html)。

## 开发

项目目前处于开发阶段，面向 Windows 10/11。使用 Tauri 2、React、Ant Design 和 Rust。

构建环境：

- Node.js 20.19+ 或 22.12+
- Rust stable（MSVC 工具链）
- Microsoft C++ Build Tools（勾选「使用 C++ 的桌面开发」）与 WebView2，安装方法见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/#windows)
- CMake 3.20+、Ninja、Git

```powershell
git clone --recurse-submodules https://github.com/Replica0110/Lyrico-Desktop.git
cd Lyrico-Desktop
npm ci
npm run tauri dev
```

已有克隆可运行 `git submodule update --init --recursive` 补齐 TagLib 子模块。

构建 Windows 安装包：

```powershell
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/nsis/`。

检查：

```powershell
npm run build
```

`npm run dev` 仅启动前端预览；完整功能需通过 `npm run tauri dev` 运行。

## 反馈与贡献

欢迎提交 Issue 和 Pull Request。报告问题时请附上 Windows 版本、音频格式、复现步骤和报错信息；测试音频请使用可公开的文件副本。

[提交问题](https://github.com/Replica0110/Lyrico-Desktop/issues)

## 许可

本仓库尚未提供许可证文件。第三方依赖的许可证见各自项目。
