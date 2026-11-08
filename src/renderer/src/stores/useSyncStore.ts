import { create } from 'zustand';
import type {
  MtpDevice,
  SyncDiffResult,
  SyncProgress,
  SyncResult,
  SyncParams,
  SyncItem,
  Song,
  M3uPathMode,
  BatchSyncEntry,
} from '@/shared/types';
import { useDeviceStore } from './useDeviceStore';

/** 浏览器预览用：Song → SyncItem 模拟条目 */
function mockSyncItem(song: Song): SyncItem {
  const name = song.filePath.split(/[\\/]/).pop() ?? `${song.title}.mp3`;
  return { song, remotePath: `\\Internal storage\\Music\\${name}`, relativePath: `./${name}` };
}

/** 音乐目录必填：只决定歌曲文件拷贝到哪里，M3U 路径写法按范例 */
const MUSIC_DIR_REQUIRED = '请填写音乐目录：歌曲文件会拷贝到该目录（M3U 中的路径写法仍按范例文件）';

/**
 * MTP 同步状态管理 —— 管理设备列表、差异对比结果、同步进度与结果。
 * 通过 window.api.mtp.* 调用主进程 IPC，浏览器预览模式下优雅降级。
 */
interface SyncState {
  // ---- 设备列表 ----
  devices: MtpDevice[];
  selectedDeviceId: string | null;
  loadingDevices: boolean;
  deviceError: string | null;

  // ---- 同步配置 ----
  remoteMusicDir: string;
  remotePlaylistDir: string;
  playlistName: string;
  /** 设备上的范例 M3U 文件路径，同步时模仿其歌曲路径格式 */
  sampleM3uPath: string;
  /** 用户选定的 M3U 歌曲路径写法；null 时自动决策（范例与音乐目录冲突时要求选择） */
  m3uPathMode: M3uPathMode | null;
  /** 自定义 M3U 路径前缀，如 /storage/XXXX-XXXX/Music/ */
  m3uCustomPrefix: string;

  // ---- Diff 结果 ----
  diffResult: SyncDiffResult | null;
  diffLoading: boolean;
  diffError: string | null;
  /** 差异分析进度（递归扫描设备目录，目录多时耗时较长） */
  diffProgress: SyncProgress | null;

  // ---- 同步进度 ----
  syncing: boolean;
  syncProgress: SyncProgress | null;
  syncResult: SyncResult | null;
  syncError: string | null;

  // ---- 批量同步 ----
  /** 勾选要批量同步的播放列表 ID（按设备记住） */
  batchPlaylistIds: number[];
  /** 批量同步当前进行到第几个播放列表（0 起） */
  batchIndex: number | null;
  /** 批量同步各播放列表结果（顺序同勾选顺序） */
  batchResults: BatchSyncEntry[] | null;

  // ---- 内部：进度订阅取消函数 ----
  unsubscribe: (() => void) | null;

  // ---- Actions ----
  loadDevices: () => Promise<void>;
  selectDevice: (id: string) => void;
  setRemoteMusicDir: (dir: string) => void;
  setRemotePlaylistDir: (dir: string) => void;
  setPlaylistName: (name: string) => void;
  setSampleM3uPath: (path: string) => void;
  setM3uPathMode: (mode: M3uPathMode | null) => void;
  setM3uCustomPrefix: (prefix: string) => void;
  analyzeDiff: (songs: Song[]) => Promise<void>;
  startSync: (songs: Song[]) => Promise<void>;
  setBatchPlaylistIds: (ids: number[]) => void;
  /** 依次同步多个播放列表，M3U 文件名使用各播放列表名称 */
  startBatchSync: (playlists: { id: number; name: string }[]) => Promise<void>;
  reset: () => void;
}

const DEFAULT_MUSIC_DIR = '\\Internal storage\\Music';
const DEFAULT_PLAYLIST_DIR = '\\Internal storage\\Playlists';

// ---- 同步配置持久化（按设备区分，存于 localStorage）----

const CONFIG_PREFIX = 'sonic-center.syncConfig.';

interface SavedSyncConfig {
  remoteMusicDir: string;
  remotePlaylistDir: string;
  playlistName: string;
  /** 旧版本存档可能缺少以下字段 */
  sampleM3uPath?: string;
  m3uPathMode?: M3uPathMode | null;
  m3uCustomPrefix?: string;
  batchPlaylistIds?: number[];
}

function loadSyncConfig(deviceId: string): SavedSyncConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_PREFIX + deviceId);
    return raw ? (JSON.parse(raw) as SavedSyncConfig) : null;
  } catch {
    return null;
  }
}

function saveSyncConfig(deviceId: string, patch: Partial<SavedSyncConfig>): void {
  try {
    const { remoteMusicDir, remotePlaylistDir, playlistName, sampleM3uPath, m3uPathMode, m3uCustomPrefix, batchPlaylistIds } =
      useSyncStore.getState();
    const prev: SavedSyncConfig = loadSyncConfig(deviceId) ?? {
      remoteMusicDir,
      remotePlaylistDir,
      playlistName,
      sampleM3uPath,
      m3uPathMode,
      m3uCustomPrefix,
      batchPlaylistIds,
    };
    localStorage.setItem(CONFIG_PREFIX + deviceId, JSON.stringify({ ...prev, ...patch }));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/**
 * 首次连接设备时探测实际的音乐/播放列表目录。
 * 扫描设备根目录找到各存储（如 P1 的 "内部存储设备"/"disk"，
 * 而非 Walkman 风格的 "Internal storage"），
 * 优先选择同时含 Music 与 Playlists 子目录的存储作为默认根。
 */
async function detectDefaultDirs(
  deviceId: string,
): Promise<{ music: string; playlists: string } | null> {
  if (!window.api) return null;
  try {
    const roots = await window.api.mtp.scan(deviceId, '\\');
    const storages = roots.filter((e) => e.isFolder);
    if (storages.length === 0) return null;

    let bestPath = storages[0].path;
    let bestScore = -1;
    for (const s of storages) {
      try {
        const subs = await window.api.mtp.scan(deviceId, s.path);
        const names = new Set(subs.map((e) => e.name.toLowerCase()));
        const score = (names.has('music') ? 1 : 0) + (names.has('playlists') ? 2 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestPath = s.path;
        }
        if (bestScore === 3) break; // Music + Playlists 均存在，无需继续扫描
      } catch {
        /* 单个存储扫描失败时跳过 */
      }
    }
    return { music: `${bestPath}\\Music`, playlists: `${bestPath}\\Playlists` };
  } catch {
    return null;
  }
}

/** 应用设备已保存的同步配置；无保存记录时探测默认目录并记住 */
async function applyDeviceConfig(device: MtpDevice): Promise<void> {
  const saved = loadSyncConfig(device.id);
  if (saved) {
    // 显式覆盖全部字段，避免残留上一设备的状态（旧存档缺字段时回退默认值）
    useSyncStore.setState({
      remoteMusicDir: saved.remoteMusicDir,
      remotePlaylistDir: saved.remotePlaylistDir,
      playlistName: saved.playlistName,
      sampleM3uPath: saved.sampleM3uPath ?? '',
      m3uPathMode: saved.m3uPathMode ?? null,
      m3uCustomPrefix: saved.m3uCustomPrefix ?? '',
      batchPlaylistIds: saved.batchPlaylistIds ?? [],
    });
    return;
  }
  const detected = await detectDefaultDirs(device.id);
  if (detected) {
    useSyncStore.setState({
      remoteMusicDir: detected.music,
      remotePlaylistDir: detected.playlists,
    });
    saveSyncConfig(device.id, {
      remoteMusicDir: detected.music,
      remotePlaylistDir: detected.playlists,
    });
  }
}

export const useSyncStore = create<SyncState>((set, get) => ({
  devices: [],
  selectedDeviceId: null,
  loadingDevices: false,
  deviceError: null,

  remoteMusicDir: DEFAULT_MUSIC_DIR,
  remotePlaylistDir: DEFAULT_PLAYLIST_DIR,
  playlistName: '',
  sampleM3uPath: '',
  m3uPathMode: null,
  m3uCustomPrefix: '',

  diffResult: null,
  diffLoading: false,
  diffError: null,
  diffProgress: null,
  syncing: false,
  syncProgress: null,
  syncResult: null,
  syncError: null,

  batchPlaylistIds: [],
  batchIndex: null,
  batchResults: null,

  unsubscribe: null,

  loadDevices: async () => {
    set({ loadingDevices: true, deviceError: null });
    try {
      const devices = window.api ? await window.api.mtp.listDevices() : [];
      set({
        devices,
        loadingDevices: false,
        selectedDeviceId: devices[0]?.id ?? null,
      });
      // 同步设备状态到全局 DeviceStore（供状态栏显示）
      useDeviceStore.getState().updateFromDevice(
        devices[0]
          ? { name: devices[0].name, freeSpace: devices[0].freeSpace, totalSpace: devices[0].totalSpace, storages: devices[0].storages }
          : null,
      );
      // 应用该设备记住的目录配置；首次连接则自动探测实际存储路径
      if (devices[0]) void applyDeviceConfig(devices[0]);
    } catch (err) {
      set({
        loadingDevices: false,
        deviceError: err instanceof Error ? err.message : String(err),
      });
      useDeviceStore.getState().updateFromDevice(null);
    }
  },

  selectDevice: (id) => {
    set({ selectedDeviceId: id });
    // 切换设备时恢复各自的目录配置
    const device = get().devices.find((d) => d.id === id);
    if (device) void applyDeviceConfig(device);
  },
  setRemoteMusicDir: (dir) => {
    // 音乐目录变化后范例与音乐目录是否一致需重新判断，清除已选写法
    set({ remoteMusicDir: dir, m3uPathMode: null });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { remoteMusicDir: dir, m3uPathMode: null });
  },
  setRemotePlaylistDir: (dir) => {
    set({ remotePlaylistDir: dir });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { remotePlaylistDir: dir });
  },
  setPlaylistName: (name) => {
    set({ playlistName: name });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { playlistName: name });
  },
  setSampleM3uPath: (path) => {
    set({ sampleM3uPath: path, m3uPathMode: null });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { sampleM3uPath: path, m3uPathMode: null });
  },
  setM3uPathMode: (mode) => {
    set({ m3uPathMode: mode });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { m3uPathMode: mode });
  },
  setM3uCustomPrefix: (prefix) => {
    set({ m3uCustomPrefix: prefix });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { m3uCustomPrefix: prefix });
  },

  analyzeDiff: async (songs) => {
    const { selectedDeviceId, remoteMusicDir, playlistName, remotePlaylistDir, sampleM3uPath, m3uPathMode, m3uCustomPrefix } =
      get();
    if (!selectedDeviceId) {
      set({ diffError: '请先选择一个 MTP 设备' });
      return;
    }
    if (!remoteMusicDir.trim()) {
      set({ diffError: MUSIC_DIR_REQUIRED });
      return;
    }
    set({ diffLoading: true, diffError: null, diffResult: null, diffProgress: null, syncResult: null, batchResults: null });
    // 订阅设备目录扫描进度（目录多时递归扫描可能耗时较长）
    const unsub = window.api
      ? window.api.mtp.onDiffProgress((p) => set({ diffProgress: p }))
      : () => {};
    try {
      const params: SyncParams = {
        deviceId: selectedDeviceId,
        songs,
        remoteMusicDir,
        playlistName: playlistName || 'My Playlist',
        remotePlaylistDir,
        // 分析阶段也需范例：用于决定路径写法并按该写法与设备 M3U 比对条目
        sampleM3uPath: sampleM3uPath || undefined,
        m3uPathMode: m3uPathMode ?? undefined,
        m3uCustomPrefix: m3uCustomPrefix || undefined,
      };
      const result = window.api
        ? await window.api.mtp.computeDiff(params)
        : // 浏览器预览：模拟一半新增一半已存在
          {
            toUpload: songs.filter((_, i) => i % 2 === 0).map(mockSyncItem),
            alreadyExist: songs.filter((_, i) => i % 2 !== 0).map(mockSyncItem),
          };
      set({ diffLoading: false, diffResult: result, diffProgress: null });
    } catch (err) {
      set({
        diffLoading: false,
        diffError: err instanceof Error ? err.message : String(err),
        diffProgress: null,
      });
    } finally {
      unsub();
    }
  },

  startSync: async (songs) => {
    const {
      selectedDeviceId,
      remoteMusicDir,
      playlistName,
      remotePlaylistDir,
      sampleM3uPath,
      m3uPathMode,
      m3uCustomPrefix,
      unsubscribe,
    } = get();
    if (!selectedDeviceId) {
      set({ syncError: '请先选择一个 MTP 设备' });
      return;
    }
    if (!remoteMusicDir.trim()) {
      set({ syncError: MUSIC_DIR_REQUIRED });
      return;
    }
    // 清理上一次进度订阅
    unsubscribe?.();
    set({
      syncing: true,
      syncError: null,
      syncResult: null,
      batchResults: null,
      syncProgress: { phase: 'scanning', current: 0, total: songs.length, percent: 0 },
    });
    // 订阅进度推送
    const unsub = window.api
      ? window.api.mtp.onSyncProgress((p) => set({ syncProgress: p }))
      : () => {};
    set({ unsubscribe: unsub });
    try {
      const params: SyncParams = {
        deviceId: selectedDeviceId,
        songs,
        remoteMusicDir,
        playlistName: playlistName || 'My Playlist',
        remotePlaylistDir,
        sampleM3uPath: sampleM3uPath || undefined,
        m3uPathMode: m3uPathMode ?? undefined,
        m3uCustomPrefix: m3uCustomPrefix || undefined,
      };
      const result = window.api
        ? await window.api.mtp.syncPlaylist(params)
        : { uploaded: songs.length, skipped: 0, failed: 0, total: songs.length, errors: [] };
      set({ syncing: false, syncResult: result });
    } catch (err) {
      set({
        syncing: false,
        syncError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unsub();
      set({ unsubscribe: null });
    }
  },

  setBatchPlaylistIds: (ids) => {
    set({ batchPlaylistIds: ids });
    const id = get().selectedDeviceId;
    if (id) saveSyncConfig(id, { batchPlaylistIds: ids });
  },

  startBatchSync: async (playlists) => {
    const { selectedDeviceId, remoteMusicDir, remotePlaylistDir, sampleM3uPath, m3uPathMode, m3uCustomPrefix, unsubscribe } =
      get();
    if (!selectedDeviceId) {
      set({ syncError: '请先选择一个 MTP 设备' });
      return;
    }
    if (!remoteMusicDir.trim()) {
      set({ syncError: MUSIC_DIR_REQUIRED });
      return;
    }
    if (playlists.length === 0) return;

    unsubscribe?.();
    const results: BatchSyncEntry[] = playlists.map((p) => ({ playlistId: p.id, playlistName: p.name }));
    set({
      syncing: true,
      syncError: null,
      syncResult: null,
      diffResult: null,
      batchIndex: 0,
      batchResults: [...results],
      syncProgress: { phase: 'scanning', current: 0, total: 0, percent: 0 },
    });
    const unsub = window.api
      ? window.api.mtp.onSyncProgress((p) => set({ syncProgress: p }))
      : () => {};
    set({ unsubscribe: unsub });

    /** 停止后续播放列表的原因（路径写法未定 / 设备无响应） */
    let stopReason: string | null = null;
    /** 路径写法未定时保留该次结果，让面板显示写法选择 */
    let abortedResult: SyncResult | null = null;
    try {
      for (let i = 0; i < playlists.length; i++) {
        const pl = playlists[i];
        set({ batchIndex: i, syncProgress: { phase: 'scanning', current: 0, total: 0, percent: 0 } });
        try {
          const songs = window.api ? await window.api.getPlaylistSongs(pl.id) : [];
          if (songs.length === 0) {
            results[i] = { ...results[i], error: '播放列表为空，已跳过' };
          } else {
            const params: SyncParams = {
              deviceId: selectedDeviceId,
              songs,
              remoteMusicDir,
              // 批量同步时 M3U 文件名使用各播放列表自己的名称
              playlistName: pl.name,
              remotePlaylistDir,
              sampleM3uPath: sampleM3uPath || undefined,
              m3uPathMode: m3uPathMode ?? undefined,
              m3uCustomPrefix: m3uCustomPrefix || undefined,
            };
            const result = await window.api!.mtp.syncPlaylist(params);
            results[i] = { ...results[i], result };
            if (result.pathPlan?.needsChoice) {
              // 写法对所有播放列表通用，后续列表同样会中止
              abortedResult = result;
              stopReason = 'M3U 歌曲路径写法尚未确定，已停止批量同步：请在上方选择写法后重新同步';
            } else if (result.deviceUnresponsive) {
              stopReason = '设备无响应，已停止后续播放列表：请重新插拔设备后再次同步（已上传的歌曲不会重复上传）';
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results[i] = { ...results[i], error: message };
          if (message.includes('MTP 设备无响应')) {
            stopReason = '设备无响应，已停止后续播放列表：请重新插拔设备后再次同步';
          }
        }
        set({ batchResults: [...results] });
        if (stopReason) break;
      }
    } finally {
      unsub();
      set({
        syncing: false,
        batchIndex: null,
        batchResults: [...results],
        syncResult: abortedResult,
        syncError: stopReason,
        unsubscribe: null,
      });
    }
  },

  reset: () => {
    const { unsubscribe } = get();
    unsubscribe?.();
    set({
      diffResult: null,
      diffError: null,
      diffProgress: null,
      syncProgress: null,
      syncResult: null,
      syncError: null,
      syncing: false,
      diffLoading: false,
      batchIndex: null,
      batchResults: null,
      unsubscribe: null,
    });
  },
}));
