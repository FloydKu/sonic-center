import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  Song,
  ScanResult,
  ScanProgress,
  TagUpdate,
  GetSongsOptions,
  Playlist,
  MtpDevice,
  MtpFileEntry,
  MtpUploadResult,
  SyncProgress,
  SyncDiffResult,
  SyncResult,
  SyncParams,
  M3uImportResult,
  AiConfig,
  AiChatMessage,
  AiTestResult,
  AiChatEvent,
  ResolvedStreamTrack,
} from '../shared/types';

/**
 * 安全 IPC 桥梁：通过 contextBridge 暴露受限 API，
 * 渲染进程通过 window.api 调用，避免暴露整个 ipcRenderer。
 */
const api = {
  // ---- 窗口控制 ----
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  },

  // ---- 对话框 ----
  selectLibraryFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectLibraryFolder'),

  // ---- 元数据读取 ----
  readTags: (filePath: string) => ipcRenderer.invoke('tags:read', filePath),

  // ---- 音乐库扫描 / 查询 ----
  /** 扫描目录；dir 省略时主进程会弹文件夹选择框。返回扫描汇总。 */
  scanDirectory: (dir?: string): Promise<ScanResult> =>
    ipcRenderer.invoke('library:scan', dir),
  /** 订阅扫描进度，返回取消订阅函数 */
  onScanProgress: (cb: (p: ScanProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: ScanProgress) => cb(p);
    ipcRenderer.on('library:scan-progress', listener);
    return () => ipcRenderer.removeListener('library:scan-progress', listener);
  },
  /** 查询库内歌曲 */
  getSongs: (opts?: GetSongsOptions): Promise<Song[]> =>
    ipcRenderer.invoke('library:getSongs', opts),
  /** 读取某首歌的封面（base64），可拼成 data URL 显示 */
  getCover: (songId: number): Promise<{ mime: string; base64: string } | null> =>
    ipcRenderer.invoke('library:getCover', songId),
  /** 编辑 Tag：写回文件并同步刷新 DB，返回更新后的歌曲 */
  updateTag: (filePath: string, update: TagUpdate): Promise<Song> =>
    ipcRenderer.invoke('library:updateTag', filePath, update),

  // ---- 播放列表 ----
  getPlaylists: (): Promise<Playlist[]> => ipcRenderer.invoke('library:getPlaylists'),
  createPlaylist: (name: string): Promise<Playlist> =>
    ipcRenderer.invoke('library:createPlaylist', name),
  addSongToPlaylist: (playlistId: number, songId: number): Promise<void> =>
    ipcRenderer.invoke('library:addSongToPlaylist', playlistId, songId),
  /** 批量添加歌曲到播放列表 */
  addSongsToPlaylist: (playlistId: number, songIds: number[]): Promise<void> =>
    ipcRenderer.invoke('library:addSongsToPlaylist', playlistId, songIds),
  getPlaylistSongs: (playlistId: number): Promise<Song[]> =>
    ipcRenderer.invoke('library:getPlaylistSongs', playlistId),
  deletePlaylist: (playlistId: number): Promise<void> =>
    ipcRenderer.invoke('library:deletePlaylist', playlistId),
  renamePlaylist: (playlistId: number, name: string): Promise<void> =>
    ipcRenderer.invoke('library:renamePlaylist', playlistId, name),
  removeSongFromPlaylist: (playlistId: number, songId: number): Promise<void> =>
    ipcRenderer.invoke('library:removeSongFromPlaylist', playlistId, songId),
  /** 导入 M3U 播放列表文件：弹出文件选择框，解析后创建播放列表并匹配库内歌曲 */
  importM3u: (): Promise<M3uImportResult | null> =>
    ipcRenderer.invoke('library:importM3u'),

  // ---- 流媒体播放源 ----
  stream: {
    /** 解析单首推荐曲目的最佳播放源（本地全曲 → Audius 全曲 → iTunes 试听） */
    resolveTrack: (title: string, artist: string): Promise<ResolvedStreamTrack> =>
      ipcRenderer.invoke('stream:resolveTrack', title, artist),
  },
  /** 用系统默认浏览器打开 https 链接 */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  // ---- AI 推荐 ----
  ai: {
    /** 读取已保存的 AI 服务配置 */
    getConfig: (): Promise<AiConfig> => ipcRenderer.invoke('ai:getConfig'),
    /** 保存 AI 服务配置 */
    setConfig: (config: Partial<AiConfig>): Promise<AiConfig> =>
      ipcRenderer.invoke('ai:setConfig', config),
    /** 测试连接（不保存配置） */
    testConnection: (config: Partial<AiConfig>): Promise<AiTestResult> =>
      ipcRenderer.invoke('ai:testConnection', config),
    /** 发起流式对话，增量经 ai:chat-chunk 事件推送 */
    chat: (messages: AiChatMessage[]): Promise<void> =>
      ipcRenderer.invoke('ai:chat', messages),
    /** 中止当前对话 */
    cancelChat: (): Promise<void> => ipcRenderer.invoke('ai:cancelChat'),
    /** 订阅对话流事件，返回取消订阅函数 */
    onChatChunk: (cb: (p: AiChatEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: AiChatEvent) => cb(p);
      ipcRenderer.on('ai:chat-chunk', listener);
      return () => ipcRenderer.removeListener('ai:chat-chunk', listener);
    },
  },

  // ---- MTP 设备 ----
  mtp: {
    /** 列出已连接的 MTP 设备 */
    listDevices: (): Promise<MtpDevice[]> =>
      ipcRenderer.invoke('mtp:listDevices'),
    /** 扫描设备指定目录下的文件和文件夹 */
    scan: (deviceId: string, folderPath: string): Promise<MtpFileEntry[]> =>
      ipcRenderer.invoke('mtp:scan', deviceId, folderPath),
    /** 上传/增量同步文件 (远程同名同大小则跳过) */
    upload: (deviceId: string, localPath: string, remotePath: string): Promise<MtpUploadResult> =>
      ipcRenderer.invoke('mtp:upload', deviceId, localPath, remotePath),
    /** 将 M3U 播放列表内容写入设备 */
    writeM3u: (deviceId: string, remotePath: string, content: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('mtp:writeM3u', deviceId, remotePath, content),
    /** 读取设备上的文本文件内容 (如 M3U 范例) */
    readM3u: (deviceId: string, remotePath: string): Promise<string> =>
      ipcRenderer.invoke('mtp:readM3u', deviceId, remotePath),
    /** 从设备删除文件 */
    delete: (deviceId: string, remotePath: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('mtp:delete', deviceId, remotePath),

    /** 计算同步差异 (不执行上传)，用于 UI 预览 */
    computeDiff: (params: SyncParams): Promise<SyncDiffResult> =>
      ipcRenderer.invoke('mtp:computeDiff', params),
    /** 订阅差异分析进度 (设备目录扫描)，返回取消订阅函数 */
    onDiffProgress: (cb: (p: SyncProgress) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: SyncProgress) => cb(p);
      ipcRenderer.on('mtp:diff-progress', listener);
      return () => ipcRenderer.removeListener('mtp:diff-progress', listener);
    },
    /** 同步播放列表到设备 (完整流程) */
    syncPlaylist: (params: SyncParams): Promise<SyncResult> =>
      ipcRenderer.invoke('mtp:syncPlaylist', params),
    /** 订阅同步进度，返回取消订阅函数 */
    onSyncProgress: (cb: (p: SyncProgress) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, p: SyncProgress) => cb(p);
      ipcRenderer.on('mtp:sync-progress', listener);
      return () => ipcRenderer.removeListener('mtp:sync-progress', listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld('api', api);

export type SonicApi = typeof api;
