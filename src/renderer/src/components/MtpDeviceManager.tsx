import { useState, useEffect, useCallback } from 'react';
import { useSyncStore } from '../stores/useSyncStore';
import type { MtpFileEntry } from '@/shared/types';
import logoUrl from '../assets/logo.png';

/** 设备播放列表条目：m3u 文件 + 解析出的歌曲行 */
interface DevicePlaylist {
  file: MtpFileEntry;
  /** M3U 内的歌曲路径行（非 # 开头的行） */
  songLines: string[];
}

/** 解析 M3U 内容，提取歌曲路径行与 EXTINF 标题行 */
function parseM3u(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * 设备文件管理面板 —— 列出播放器内已存在的播放列表，
 * 点击加载 M3U 内容展示列表内的歌曲。
 */
export default function MtpDeviceManager() {
  const devices = useSyncStore((s) => s.devices);
  const selectedDeviceId = useSyncStore((s) => s.selectedDeviceId);
  const remotePlaylistDir = useSyncStore((s) => s.remotePlaylistDir);
  const loadingDevices = useSyncStore((s) => s.loadingDevices);
  const deviceError = useSyncStore((s) => s.deviceError);

  const [playlists, setPlaylists] = useState<DevicePlaylist[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  /** 扫描设备播放列表目录，列出全部 m3u 文件（不读内容，秒级完成） */
  const loadPlaylists = useCallback(async () => {
    if (!selectedDeviceId || !window.api) return;
    setScanning(true);
    setError('');
    setPlaylists([]);
    setSelectedName(null);
    try {
      const entries = await window.api.mtp.scan(selectedDeviceId, remotePlaylistDir);
      const m3uFiles = entries
        .filter((e) => !e.isFolder && /\.m3u8?$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      setPlaylists(m3uFiles.map((file) => ({ file, songLines: [] })));
    } catch (err) {
      // 播放列表目录不存在时（如 Walkman 空设备）给出友好提示
      const msg = err instanceof Error ? err.message : String(err);
      setError(/not found/i.test(msg) ? `${remotePlaylistDir} 目录不存在` : msg);
    } finally {
      setScanning(false);
    }
  }, [selectedDeviceId, remotePlaylistDir]);

  // 设备就绪时自动加载一次
  useEffect(() => {
    if (selectedDeviceId) void loadPlaylists();
  }, [selectedDeviceId, loadPlaylists]);

  /** 点击播放列表 → 读取 M3U 内容解析歌曲行 */
  const openPlaylist = async (pl: DevicePlaylist) => {
    if (!selectedDeviceId || !window.api) return;
    setSelectedName(pl.file.name);
    if (pl.songLines.length > 0) return; // 已加载过
    try {
      const content = await window.api.mtp.readM3u(selectedDeviceId, pl.file.path);
      const songLines = parseM3u(content);
      setPlaylists((prev) =>
        prev.map((p) => (p.file.path === pl.file.path ? { ...p, songLines } : p)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selected = playlists.find((p) => p.file.name === selectedName) ?? null;

  return (
    <div className="mtp-panel">
      {/* —— 工具栏 —— */}
      <div className="mtp-toolbar">
        <div className="mtp-toolbar-row">
          <label className="mtp-field">
            <span className="mtp-field-label">设备</span>
            <select
              className="mtp-select"
              value={selectedDeviceId ?? ''}
              onChange={(e) => useSyncStore.getState().selectDevice(e.target.value)}
              disabled={loadingDevices}
            >
              {devices.length === 0 && <option value="">未检测到设备</option>}
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mtp-field mtp-field-grow">
            <span className="mtp-field-label">播放列表目录</span>
            <input className="mtp-input" value={remotePlaylistDir} readOnly />
          </label>
          <button
            className="mtp-btn mtp-btn-secondary"
            onClick={() => void loadPlaylists()}
            disabled={!selectedDeviceId || scanning}
          >
            <span className={`codicon codicon-refresh ${scanning ? 'codicon-modifier-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {(error || deviceError) && <div className="mtp-error">{error || deviceError}</div>}

      {/* —— 双栏：左侧播放列表，右侧歌曲 —— */}
      <div className="mtp-diff-view">
        <div className="mtp-diff-col">
          <div className="mtp-diff-col-header">
            <span className="codicon codicon-list-selection" />
            <span>设备播放列表</span>
            <span className="mtp-diff-count">{playlists.length} 个</span>
          </div>
          <div className="mtp-diff-col-body">
            {scanning && (
              <div className="mtp-diff-empty">
                <span className="codicon codicon-sync codicon-modifier-spin" /> 正在读取...
              </div>
            )}
            {!scanning && playlists.length === 0 && !error && (
              <div className="mtp-diff-empty">设备上没有播放列表</div>
            )}
            {playlists.map((pl) => (
              <div
                key={pl.file.path}
                className={`mtp-song-item ${selectedName === pl.file.name ? 'active' : ''}`}
                onClick={() => void openPlaylist(pl)}
                title={pl.file.path}
              >
                <span className="codicon codicon-file mtp-song-index" />
                <div className="mtp-song-info">
                  <span className="mtp-song-title">{pl.file.name}</span>
                  <span className="mtp-song-artist">
                    {pl.songLines.length > 0 ? `${pl.songLines.length} 首` : formatSize(pl.file.size)}
                  </span>
                </div>
                <span className="codicon codicon-chevron-right mtp-song-index" />
              </div>
            ))}
          </div>
        </div>

        <div className="mtp-diff-col">
          <div className="mtp-diff-col-header">
            <img className="app-logo-img" src={logoUrl} alt="" />
            <span>{selected ? selected.file.name : '歌曲'}</span>
            {selected && selected.songLines.length > 0 && (
              <span className="mtp-diff-count">{selected.songLines.length} 首</span>
            )}
          </div>
          <div className="mtp-diff-col-body">
            {!selected && <div className="mtp-diff-empty">点击左侧播放列表查看歌曲</div>}
            {selected && selected.songLines.length === 0 && (
              <div className="mtp-diff-empty">
                <span className="codicon codicon-sync codicon-modifier-spin" /> 正在读取...
              </div>
            )}
            {selected?.songLines.map((line, i) => (
              <div key={i} className="mtp-song-item" title={line}>
                <span className="mtp-song-index">{i + 1}</span>
                <div className="mtp-song-info">
                  <span className="mtp-song-title">{songTitle(line)}</span>
                  <span className="mtp-song-artist">{line}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 从路径行提取文件名作为标题 */
function songTitle(line: string): string {
  const parts = line.split(/[\\/]/);
  return parts[parts.length - 1] || line;
}

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
