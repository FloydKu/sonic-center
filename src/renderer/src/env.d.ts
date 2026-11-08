/// <reference types="vite/client" />

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
} from '@/shared/types';

// 与 src/preload/index.ts 中 contextBridge.exposeInMainWorld('api', ...) 对应
export interface SonicApi {
  // ---- 窗口控制 ----
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
  };

  // ---- 对话框 ----
  selectLibraryFolder(): Promise<string | null>;

  // ---- 元数据读取 ----
  readTags(filePath: string): Promise<unknown>;

  // ---- 音乐库扫描 / 查询 ----
  scanDirectory(dir?: string): Promise<ScanResult>;
  onScanProgress(cb: (p: ScanProgress) => void): () => void;
  getSongs(opts?: GetSongsOptions): Promise<Song[]>;
  getCover(songId: number): Promise<{ mime: string; base64: string } | null>;
  updateTag(filePath: string, update: TagUpdate): Promise<Song>;

  // ---- 播放列表 ----
  getPlaylists(): Promise<Playlist[]>;
  createPlaylist(name: string): Promise<Playlist>;
  addSongToPlaylist(playlistId: number, songId: number): Promise<void>;
  addSongsToPlaylist(playlistId: number, songIds: number[]): Promise<void>;
  getPlaylistSongs(playlistId: number): Promise<Song[]>;
  deletePlaylist(playlistId: number): Promise<void>;
  renamePlaylist(playlistId: number, name: string): Promise<void>;
  removeSongFromPlaylist(playlistId: number, songId: number): Promise<void>;
  /** 导入 M3U 播放列表文件 */
  importM3u(): Promise<M3uImportResult | null>;

  // ---- 流媒体播放源 ----
  stream: {
    /** 解析单首推荐曲目的最佳播放源（本地全曲 → Audius 全曲 → iTunes 试听） */
    resolveTrack(title: string, artist: string): Promise<ResolvedStreamTrack>;
  };
  /** 用系统默认浏览器打开 https 链接 */
  openExternal(url: string): Promise<void>;

  // ---- AI 推荐 ----
  ai: {
    /** 读取已保存的 AI 服务配置 */
    getConfig(): Promise<AiConfig>;
    /** 保存 AI 服务配置 */
    setConfig(config: Partial<AiConfig>): Promise<AiConfig>;
    /** 测试连接（不保存配置） */
    testConnection(config: Partial<AiConfig>): Promise<AiTestResult>;
    /** 发起流式对话，增量经 onChatChunk 事件推送 */
    chat(messages: AiChatMessage[]): Promise<void>;
    /** 中止当前对话 */
    cancelChat(): Promise<void>;
    /** 订阅对话流事件，返回取消订阅函数 */
    onChatChunk(cb: (p: AiChatEvent) => void): () => void;
  };

  // ---- MTP 设备 ----
  mtp: {
    listDevices(): Promise<MtpDevice[]>;
    scan(deviceId: string, folderPath: string): Promise<MtpFileEntry[]>;
    upload(deviceId: string, localPath: string, remotePath: string): Promise<MtpUploadResult>;
    writeM3u(deviceId: string, remotePath: string, content: string): Promise<{ ok: boolean }>;
    /** 读取设备上的文本文件内容 (如 M3U 范例) */
    readM3u(deviceId: string, remotePath: string): Promise<string>;
    delete(deviceId: string, remotePath: string): Promise<{ ok: boolean }>;
    /** 计算同步差异 (不执行上传)，用于 UI 预览 */
    computeDiff(params: SyncParams): Promise<SyncDiffResult>;
    /** 订阅差异分析进度 (设备目录扫描)，返回取消订阅函数 */
    onDiffProgress(cb: (p: SyncProgress) => void): () => void;
    /** 同步播放列表到设备 (完整流程) */
    syncPlaylist(params: SyncParams): Promise<SyncResult>;
    /** 订阅同步进度，返回取消订阅函数 */
    onSyncProgress(cb: (p: SyncProgress) => void): () => void;
  };
}

declare global {
  interface Window {
    api: SonicApi;
  }
}

export {};
