import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron';
import * as path from 'path';
import { createReadStream, statSync, readFileSync } from 'fs';
import { Readable } from 'stream';
import { initDatabase, closeDatabase, createPlaylist, listPlaylists, addSongToPlaylist, addSongsToPlaylist, getPlaylistSongs, deletePlaylist, renamePlaylist, removeSongFromPlaylist, findSongIdsByPaths } from './db';
import { readTags } from './tagEditor';
import { scanLibrary, getSongs, getSongCover, updateTag } from './libraryService';
import { listDevices, scanDevice, uploadFile, writeM3u, readM3u, deleteFile, syncPlaylistToDevice, computeSyncDiff } from './mtpService';
import { loadAiConfig, saveAiConfig, testAiConnection, streamAiChat, cancelAiChat } from './aiService';
import { resolveTrack } from './streamingService';
import type { GetSongsOptions, TagUpdate, SyncParams, M3uImportResult, AiConfig, AiChatMessage, AiChatEvent } from '../shared/types';

// 注册自定义协议，允许渲染进程通过 local-media:// 加载本地音频文件流
// 必须在 app.whenReady() 之前调用
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-media', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } },
]);

let mainWindow: BrowserWindow | null = null;

// 稳定的 AppUserModelID：portable 版每次从随机临时目录启动，路径不固定，
// 不显式设置时 Windows 任务栏无法建立稳定的图标/分组关联（会显示陌生图标）
app.setAppUserModelId('com.audiopivot.app');

// 单实例锁：portable 版重复双击会各自解压一份并运行多个实例，
// 任务栏出现多窗口分组；第二个实例直接退出，并唤起已有窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// 开发模式开启 CDP 远程调试端口，便于外部诊断渲染进程运行时状态
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

function createWindow(): void {
  // 显式窗口图标：运行时通过 WM_SETICON 设定，优先于 exe 资源与图标缓存，
  // 保证 portable 临时目录运行下任务栏/窗口图标始终正确
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1e1e1e',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 开发模式加载 Vite Dev Server（可用 VITE_DEV_SERVER_URL 覆盖端口），生产模式加载打包产物
  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** 解析扫描目录：传入则直接用，否则弹出文件夹选择框 */
async function resolveScanDir(dir?: string): Promise<string> {
  if (dir) return dir;
  if (!mainWindow) throw new Error('无可用窗口以打开文件夹选择框');
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) throw new Error('未选择目录');
  return r.filePaths[0];
}

function registerIpcHandlers(): void {
  // ---- 窗口控制（无边框窗口的自定义标题栏按钮）----
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  // ---- 文件对话框 ----
  ipcMain.handle('dialog:selectLibraryFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ---- 元数据读取 ----
  ipcMain.handle('tags:read', (_event, filePath: string) => readTags(filePath));

  // ---- 音乐库扫描 / 查询 ----
  ipcMain.handle('library:scan', async (event, dir?: string) => {
    const target = await resolveScanDir(dir);
    return scanLibrary(target, (p) => event.sender.send('library:scan-progress', p));
  });

  ipcMain.handle('library:getSongs', (_event, opts?: GetSongsOptions) => getSongs(opts));
  ipcMain.handle('library:getCover', (_event, songId: number) => getSongCover(songId));
  ipcMain.handle('library:updateTag', (_event, filePath: string, update: TagUpdate) =>
    updateTag(filePath, update),
  );

  // ---- 播放列表 ----
  ipcMain.handle('library:getPlaylists', () => listPlaylists());
  ipcMain.handle('library:createPlaylist', (_event, name: string) => createPlaylist(name));
  ipcMain.handle('library:addSongToPlaylist', (_event, playlistId: number, songId: number) =>
    addSongToPlaylist(playlistId, songId),
  );
  ipcMain.handle('library:addSongsToPlaylist', (_event, playlistId: number, songIds: number[]) =>
    addSongsToPlaylist(playlistId, songIds),
  );
  ipcMain.handle('library:getPlaylistSongs', (_event, playlistId: number) =>
    getPlaylistSongs(playlistId),
  );
  ipcMain.handle('library:deletePlaylist', (_event, playlistId: number) => deletePlaylist(playlistId));
  ipcMain.handle('library:renamePlaylist', (_event, playlistId: number, name: string) =>
    renamePlaylist(playlistId, name),
  );
  ipcMain.handle('library:removeSongFromPlaylist', (_event, playlistId: number, songId: number) =>
    removeSongFromPlaylist(playlistId, songId),
  );

  // ---- M3U 导入 ----
  ipcMain.handle('library:importM3u', async () => {
    if (!mainWindow) throw new Error('无可用窗口');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 M3U 播放列表',
      filters: [
        { name: 'M3U 播放列表', extensions: ['m3u', 'm3u8'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const m3uPath = result.filePaths[0];
    const content = readFileSync(m3uPath, 'utf-8');
    const m3uDir = path.dirname(m3uPath);

    // 解析 M3U：提取文件路径行（跳过 # 开头的指令/注释）
    const entries: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // 相对路径则基于 M3U 文件目录解析为绝对路径
      const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(m3uDir, trimmed);
      entries.push(resolved);
    }

    if (entries.length === 0) {
      return { playlistId: 0, playlistName: '', totalEntries: 0, matchedCount: 0 } as M3uImportResult;
    }

    // 匹配库内歌曲
    const matched = findSongIdsByPaths(entries);
    const songIds = [...matched.values()];

    // 以 M3U 文件名（不含扩展名）作为播放列表名
    const playlistName = path.basename(m3uPath, path.extname(m3uPath));
    const playlist = createPlaylist(playlistName);

    if (songIds.length > 0) {
      addSongsToPlaylist(playlist.id, songIds);
    }

    return {
      playlistId: playlist.id,
      playlistName: playlist.name,
      totalEntries: entries.length,
      matchedCount: songIds.length,
    } as M3uImportResult;
  });

  // ---- AI 推荐 ----
  ipcMain.handle('ai:getConfig', () => loadAiConfig());
  ipcMain.handle('ai:setConfig', (_event, config: Partial<AiConfig>) => saveAiConfig(config));
  ipcMain.handle('ai:testConnection', (_event, config: Partial<AiConfig>) =>
    testAiConnection(config),
  );
  ipcMain.handle('ai:chat', async (event, messages: AiChatMessage[]) => {
    const config = await loadAiConfig();
    const send = (p: AiChatEvent) => event.sender.send('ai:chat-chunk', p);
    try {
      await streamAiChat(config, messages, (delta) =>
        send({ done: false, chunk: delta.content, reasoning: delta.reasoning }),
      );
      send({ done: true });
    } catch (e) {
      send({ done: true, error: (e as Error).message });
    }
  });
  ipcMain.handle('ai:cancelChat', () => cancelAiChat());

  // ---- 流媒体播放源解析 ----
  ipcMain.handle('stream:resolveTrack', (_event, title: string, artist: string) =>
    resolveTrack(title, artist),
  );
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    // 仅放行 https，防止任意协议唤起系统程序
    if (!/^https:\/\//i.test(url)) {
      return Promise.reject(new Error('仅支持打开 https 链接'));
    }
    return shell.openExternal(url);
  });

  // ---- MTP 设备 ----
  ipcMain.handle('mtp:listDevices', () => listDevices());
  ipcMain.handle('mtp:scan', (_event, deviceId: string, folderPath: string) =>
    scanDevice(deviceId, folderPath),
  );
  ipcMain.handle('mtp:upload', (_event, deviceId: string, localPath: string, remotePath: string) =>
    uploadFile(deviceId, localPath, remotePath),
  );
  ipcMain.handle('mtp:writeM3u', (_event, deviceId: string, remotePath: string, content: string) =>
    writeM3u(deviceId, remotePath, content),
  );
  ipcMain.handle('mtp:readM3u', (_event, deviceId: string, remotePath: string) =>
    readM3u(deviceId, remotePath),
  );
  ipcMain.handle('mtp:delete', (_event, deviceId: string, remotePath: string) =>
    deleteFile(deviceId, remotePath),
  );
  ipcMain.handle(
    'mtp:computeDiff',
    (event, params: SyncParams) =>
      computeSyncDiff(params, (p) => event.sender.send('mtp:diff-progress', p)),
  );
  ipcMain.handle('mtp:syncPlaylist', async (event, params: SyncParams) =>
    syncPlaylistToDevice(params, (p) => event.sender.send('mtp:sync-progress', p)),
  );
}

app.whenReady().then(() => {
  if (!gotTheLock) return; // 第二实例正在退出，不再初始化
  initDatabase();
  registerIpcHandlers();

  // 处理 local-media:// 请求：解码文件路径，用 fs.createReadStream 返回流式 Response
  // 支持 Range 请求（206 Partial Content），使 HTML5 Audio 元素可以 seek
  protocol.handle('local-media', async (req) => {
    const encoded = req.url.slice('local-media://'.length);
    const filePath = decodeURIComponent(encoded);
    const stat = statSync(filePath);
    const range = req.headers.get('range');

    if (range) {
      // 解析 Range: bytes=12345- 或 bytes=12345-67890
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        const nodeStream = createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': (end - start + 1).toString(),
          },
        });
      }
    }

    // 无 Range 头或解析失败：返回完整文件
    const nodeStream = createReadStream(filePath);
    return new Response(Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size.toString(),
      },
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  closeDatabase();
});
