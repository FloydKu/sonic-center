<p align="center">
  <img src="build/icon.png" width="128" alt="AudioPivot 音枢" />
</p>

<h1 align="center">AudioPivot 音枢</h1>

<p align="center">
  VS Code 风格的 Windows 本地音乐管理中心：曲库管理 · 标签编辑 · 播放列表 · AI 推荐 · MTP 播放器同步
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20x64-0078d4" />
  <img alt="electron" src="https://img.shields.io/badge/Electron-32-47848f" />
  <img alt="react" src="https://img.shields.io/badge/React-18-61dafb" />
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-brightgreen" />
</p>

---

## 下载

到 [Releases](https://github.com/FloydKu/sonic-center/releases/latest) 下载 `AudioPivot-<版本>-portable.exe`，这是便携版单文件程序，双击即可运行，无需安装。

- 系统要求：Windows 10 / 11 x64
- 程序未做代码签名，首次运行时 SmartScreen 可能提示“已保护你的电脑”，点击“更多信息 → 仍要运行”即可。

## 功能

### 音乐库
- 选择本地文件夹扫描音乐，支持 **MP3 / FLAC / WAV / M4A**，曲目信息保存在本地 SQLite 数据库中
- 虚拟滚动列表，大曲库也能流畅浏览；可显示专辑封面
- 内置播放器，支持播放队列、随机播放、循环模式、进度拖动和音量调节

### 标签编辑
- 可编辑歌名、歌手、专辑和封面，修改直接写回音频文件
- MP3 / WAV 写入 ID3v2，FLAC 写入 Vorbis Comment / PICTURE 块
- M4A 目前只能读取，不能写入

### 播放列表
- 支持新建、重命名、删除播放列表，可批量添加歌曲，也可以移除歌曲
- 可导入 `.m3u` / `.m3u8` 播放列表

### AI 推荐
- 支持任意 **OpenAI 兼容接口**，包括 OpenAI、DeepSeek、通义千问、Kimi，以及 Ollama 等本地服务；对话流式输出，并能展示推理模型的思考过程
- AI 只输出“歌名 - 歌手”，播放源由应用自行解析，不使用 AI 生成的链接。解析顺序为：
  1. 本地曲库中的完整歌曲
  2. [Audius](https://audius.co) 上免费的完整歌曲
  3. iTunes 的 30 秒试听
  4. 以上都没有时，跳转到网易云音乐的搜索页

### MTP 设备同步
通过 USB（MTP 协议）把播放列表同步到 Android 手机或支持 MTP 的音乐播放器：

- **差异分析**：同步前先比对设备上已有的文件，只上传缺少的歌曲；同名但大小不同的文件会被替换
- **批量同步**：可一次勾选多个播放列表依次同步；已扫描过的设备目录会复用，不重复扫描
- **M3U 播放列表**：在设备上生成 M3U 文件，未发生变化时不重写。歌曲路径有三种写法：
  - 按范例文件：参照设备上已有的、能正常播放的 M3U
  - 按音乐目录
  - 自定义前缀，例如 `/storage/XXXX-XXXX/Music/`
- 设备上的目录结构为 `音乐目录\歌手\专辑\文件名`；会自动处理 FAT/exFAT 存储卡不允许的字符和名称结尾的点
- 设备无响应时会停止同步，不会强行重试导致设备卡死；同步配置按设备分别保存

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 32 |
| 界面 | React 18 + Zustand + [@vscode/codicons](https://github.com/microsoft/vscode-codicons) |
| 构建 | Vite 5（渲染进程）+ TypeScript 5（主进程 / preload） |
| 数据 | better-sqlite3 |
| 音频元数据 | music-metadata（读取）、node-id3 / 自研 FLAC 写入 |
| MTP 桥接 | C# .NET 8 + [MediaDevices](https://github.com/Bassman2/MediaDevices)，Native AOT 编译成独立 exe |

## 项目结构

```
├── src
│   ├── main/            # Electron 主进程：曲库、标签、AI、流媒体、MTP 同步
│   ├── preload/         # contextBridge 暴露给渲染进程的 API
│   ├── renderer/        # React 界面（components / stores / hooks）
│   └── shared/          # 主进程与渲染进程共用的类型定义
├── mtp-bridge/          # C# MTP 命令行桥接器（Program.cs）
├── scripts/             # 辅助脚本（better-sqlite3 预编译包修复）
├── build/               # 应用图标
├── build-mtp.ps1        # mtp-bridge Native AOT 编译脚本
└── electron-builder.yml # 打包配置（Windows portable）
```

## 本地开发

### 环境要求

- Node.js 20 及以上（已在 Node 24 上验证）
- 如需使用或修改 MTP 功能，还要编译 mtp-bridge，需要：
  - [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
  - Visual Studio 2022 或更新版本，并安装“使用 C++ 的桌面开发”工作负载（Native AOT 链接需要）

### 安装依赖

```bash
npm install
```

> `.npmrc` 中把 npm、Electron 和 better-sqlite3 的下载源设成了 npmmirror 镜像，方便国内网络。如果你在海外，可以删掉 `.npmrc`。
>
> 如果 better-sqlite3 的原生模块没有装好（启动时报找不到 `better_sqlite3.node`），运行
> `node scripts/ensure-sqlite-prebuild.js`，它会下载与当前 Electron 版本匹配的预编译包。

### 编译 MTP 桥接器

```bash
npm run build:mtp
```

编译结果输出到 `resources/mtp-bridge/mtp-bridge.exe`。不编译也能运行应用，只是 MTP 相关功能用不了。

### 启动开发环境

```bash
npm run dev
```

这条命令会同时启动 Vite 开发服务器（端口 5173）和 Electron 主进程。

### 类型检查

```bash
npx tsc --noEmit -p tsconfig.node.json   # 主进程 / preload
npx tsc --noEmit -p tsconfig.json        # 渲染进程
```

### 打包

```bash
npm run build:mtp   # 如果 mtp-bridge 有改动
npm run dist
```

打包结果为 `release/AudioPivot-音枢-<版本>.exe`。

## 数据存放位置

所有数据都只保存在本机的 `%APPDATA%\sonic-center\` 目录下：

| 文件 | 内容 |
| --- | --- |
| `library.db` | 曲库与播放列表 |
| `ai-config.json` | AI 接口地址、模型和 API Key（**明文保存**，请注意本机账户安全） |
| `mtp-file-cache.json` | 设备上 M3U 文件内容的缓存，用于减少对设备的读取 |

应用只会访问以下网络服务：你配置的 AI 接口，以及用于解析 AI 推荐曲目播放源的 Audius 和 iTunes 公开 API。

## 已知限制

- MTP 同步只支持 Windows（依赖 Windows Portable Devices API）
- M4A 文件的标签暂不支持写入
- 批量同步时，如果两个播放列表的名称去掉非法字符后相同，它们的 M3U 会写到同一个文件，后同步的会覆盖先同步的
- 不同设备的 MTP 实现差异较大。如果同步时设备没有响应，请重新插拔设备后再试

## 许可证

尚未指定。
