import { useEffect, useState } from 'react';
import { useSyncStore } from '../stores/useSyncStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import MtpFolderBrowser from './MtpFolderBrowser';
import type { Song, Playlist as SharedPlaylist, M3uPathMode, BatchSyncEntry } from '@/shared/types';
import logoUrl from '../assets/logo.png';

/** 格式化传输速度 */
function formatSpeed(bps: number): string {
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${bps} B/s`;
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 设备路径比较（忽略分隔符、末尾分隔符与大小写） */
function sameDevicePath(a: string, b: string): boolean {
  const norm = (p: string) => p.split(/[\\/]+/).filter(Boolean).join('\\').toLowerCase();
  return norm(a) === norm(b);
}

const PHASE_LABELS: Record<string, string> = {
  scanning: '扫描设备',
  diffing: '对比差异',
  uploading: '上传中',
  'writing-playlist': '写入播放列表',
  done: '完成',
};

/** 批量同步中单个播放列表的状态文字与样式 */
function describeBatchEntry(
  entry: BatchSyncEntry,
  running: boolean,
  syncing: boolean,
): { text: string; tone: 'ok' | 'fail' | 'muted' | 'running' } {
  if (running) return { text: '同步中…', tone: 'running' };
  const r = entry.result;
  if (!r) {
    if (entry.error) {
      return entry.error.startsWith('播放列表为空') ? { text: '已跳过', tone: 'muted' } : { text: '失败', tone: 'fail' };
    }
    return { text: syncing ? '等待中' : '未执行', tone: 'muted' };
  }
  if (r.pathPlan?.needsChoice) return { text: '已中止（路径写法未定）', tone: 'fail' };
  const list = r.playlistWritten
    ? '列表已更新'
    : r.deviceUnresponsive
      ? '列表未写入'
      : r.errors.some((e) => e.startsWith('播放列表写入失败'))
        ? '列表写入失败'
        : '列表无变化';
  const parts = [`上传 ${r.uploaded}`, `跳过 ${r.skipped}`];
  if (r.failed > 0) parts.push(`失败 ${r.failed}`);
  parts.push(list);
  return { text: parts.join(' · '), tone: r.failed > 0 || r.deviceUnresponsive ? 'fail' : 'ok' };
}

/** 浏览器预览用模拟播放列表 */
const MOCK_PLAYLISTS: SharedPlaylist[] = [
  { id: 1, name: '我喜欢的音乐', songCount: 128, createdAt: '' },
  { id: 2, name: '跑步节奏', songCount: 42, createdAt: '' },
  { id: 3, name: '深夜电台', songCount: 67, createdAt: '' },
];

/**
 * MTP 同步面板 —— 双栏 Diff View + 实时进度
 * 左栏：本地待同步列表（带 需上传/加入列表/无变化 标签）
 * 右栏：设备当前状态 + 差异摘要（含与设备同名播放列表的条目对比）
 */
export default function MtpSyncPanel() {
  const devices = useSyncStore((s) => s.devices);
  const selectedDeviceId = useSyncStore((s) => s.selectedDeviceId);
  const loadingDevices = useSyncStore((s) => s.loadingDevices);
  const deviceError = useSyncStore((s) => s.deviceError);
  const remoteMusicDir = useSyncStore((s) => s.remoteMusicDir);
  const remotePlaylistDir = useSyncStore((s) => s.remotePlaylistDir);
  const playlistName = useSyncStore((s) => s.playlistName);
  const sampleM3uPath = useSyncStore((s) => s.sampleM3uPath);
  const m3uPathMode = useSyncStore((s) => s.m3uPathMode);
  const m3uCustomPrefix = useSyncStore((s) => s.m3uCustomPrefix);
  const diffResult = useSyncStore((s) => s.diffResult);
  const diffLoading = useSyncStore((s) => s.diffLoading);
  const diffError = useSyncStore((s) => s.diffError);
  const diffProgress = useSyncStore((s) => s.diffProgress);
  const syncing = useSyncStore((s) => s.syncing);
  const syncProgress = useSyncStore((s) => s.syncProgress);
  const syncResult = useSyncStore((s) => s.syncResult);
  const syncError = useSyncStore((s) => s.syncError);
  const loadDevices = useSyncStore((s) => s.loadDevices);
  const selectDevice = useSyncStore((s) => s.selectDevice);
  const setRemoteMusicDir = useSyncStore((s) => s.setRemoteMusicDir);
  const setRemotePlaylistDir = useSyncStore((s) => s.setRemotePlaylistDir);
  const setPlaylistName = useSyncStore((s) => s.setPlaylistName);
  const setSampleM3uPath = useSyncStore((s) => s.setSampleM3uPath);
  const setM3uPathMode = useSyncStore((s) => s.setM3uPathMode);
  const setM3uCustomPrefix = useSyncStore((s) => s.setM3uCustomPrefix);
  const analyzeDiff = useSyncStore((s) => s.analyzeDiff);
  const startSync = useSyncStore((s) => s.startSync);
  const batchPlaylistIds = useSyncStore((s) => s.batchPlaylistIds);
  const batchIndex = useSyncStore((s) => s.batchIndex);
  const batchResults = useSyncStore((s) => s.batchResults);
  const setBatchPlaylistIds = useSyncStore((s) => s.setBatchPlaylistIds);
  const startBatchSync = useSyncStore((s) => s.startBatchSync);

  const [playlists, setPlaylists] = useState<SharedPlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  /** 正在浏览的目录字段：'music' | 'playlist' | 'sample' | null */
  const [browsingField, setBrowsingField] = useState<'music' | 'playlist' | 'sample' | null>(null);
  /** 是否展开批量勾选播放列表 */
  const [batchOpen, setBatchOpen] = useState(false);
  /** 自定义路径前缀输入框（点“应用”后才写入配置并重新分析） */
  const [customPrefixDraft, setCustomPrefixDraft] = useState(m3uCustomPrefix);
  useEffect(() => setCustomPrefixDraft(m3uCustomPrefix), [m3uCustomPrefix]);

  // 挂载时加载设备列表与播放列表；库数据未就绪时先触发加载
  useEffect(() => {
    loadDevices();
    loadPlaylists();
    if (useLibraryStore.getState().tracks.length === 0) {
      useLibraryStore.getState().loadSongs();
    }
  }, []);

  // 库曲目变化且未选播放列表时，同步刷新待同步列表
  const libraryTracks = useLibraryStore((s) => s.tracks);
  useEffect(() => {
    if (selectedPlaylistId === null && libraryTracks.length > 0) {
      setSongs(libraryTracks);
    }
  }, [libraryTracks, selectedPlaylistId]);

  // 选中播放列表后加载歌曲
  useEffect(() => {
    if (selectedPlaylistId !== null) loadSongs(selectedPlaylistId);
  }, [selectedPlaylistId]);

  async function loadPlaylists() {
    try {
      const pl = window.api ? await window.api.getPlaylists() : MOCK_PLAYLISTS;
      setPlaylists(pl);
      if (pl[0]) setSelectedPlaylistId(pl[0].id);
      else setSongs(useLibraryStore.getState().tracks); // 无播放列表时默认同步整个库
    } catch {
      setPlaylists(MOCK_PLAYLISTS);
    }
  }

  async function loadSongs(playlistId: number) {
    const pl = playlists.find((p) => p.id === playlistId);
    if (pl) setPlaylistName(pl.name);
    const libraryTracks = useLibraryStore.getState().tracks;
    try {
      const s = window.api ? await window.api.getPlaylistSongs(playlistId) : libraryTracks;
      setSongs(s.length > 0 ? s : libraryTracks); // 播放列表为空时回退到整个库
    } catch {
      setSongs(libraryTracks);
    }
  }

  // 构建差异状态映射：filePath → 'upload'（文件需上传）| 'link'（文件已在设备，仅加入播放列表）| 'exist'
  const diffMap = new Map<string, 'upload' | 'link' | 'exist'>();
  let linkCount = 0;
  if (diffResult) {
    const added = new Set(diffResult.playlist?.addedFilePaths ?? []);
    for (const item of diffResult.toUpload) diffMap.set(item.song.filePath, 'upload');
    for (const item of diffResult.alreadyExist) {
      const isLink = added.has(item.song.filePath);
      if (isLink) linkCount++;
      diffMap.set(item.song.filePath, isLink ? 'link' : 'exist');
    }
  }
  const playlistDiff = diffResult?.playlist;
  const playlistFileName = playlistDiff?.remotePath.split('\\').pop() ?? '';
  // M3U 路径写法决策（分析或同步中止时给出）；needsChoice 时须由用户选择后才能同步
  const pathPlan = syncResult?.pathPlan ?? diffResult?.pathPlan;
  const syncAborted = !!syncResult?.pathPlan?.needsChoice;
  // 范例可解析但设备上找不到其中的歌曲时同样不可选，照抄只会写出无法播放的路径
  const sampleSelectable = !!pathPlan?.sampleExample && !pathPlan.sampleError;

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);
  // 批量模式：展开勾选且至少勾选一个播放列表（按列表显示顺序同步，忽略已删除的列表）
  const checkedIds = new Set(batchPlaylistIds);
  const batchTargets = playlists.filter((p) => checkedIds.has(p.id));
  const batchMode = batchOpen && batchTargets.length > 0;
  // 分析与同步互斥：MTP 设备为独占连接，两个操作并发会导致子进程挂起
  const canAnalyze = selectedDeviceId && songs.length > 0 && !diffLoading && !syncing;
  const canSync =
    selectedDeviceId &&
    (batchMode || songs.length > 0) &&
    !syncing &&
    !diffLoading &&
    !diffResult?.pathPlan?.needsChoice;
  const batchTotals = batchResults?.reduce(
    (acc, e) => ({
      uploaded: acc.uploaded + (e.result?.uploaded ?? 0),
      skipped: acc.skipped + (e.result?.skipped ?? 0),
      failed: acc.failed + (e.result?.failed ?? 0),
    }),
    { uploaded: 0, skipped: 0, failed: 0 },
  );

  function toggleBatchPlaylist(id: number) {
    setBatchPlaylistIds(checkedIds.has(id) ? batchPlaylistIds.filter((x) => x !== id) : [...batchPlaylistIds, id]);
  }

  function handleStartSync() {
    if (batchMode) void startBatchSync(batchTargets.map((p) => ({ id: p.id, name: p.name })));
    else void startSync(songs);
  }

  /** 选择路径写法后立即重新分析（写法影响与设备 M3U 的条目对比） */
  function choosePathMode(mode: M3uPathMode | null) {
    if (mode === 'custom') {
      const prefix = customPrefixDraft.trim();
      if (!prefix) return;
      setM3uCustomPrefix(prefix);
    }
    setM3uPathMode(mode);
    void analyzeDiff(songs);
  }

  return (
    <div className="mtp-panel">
      {/* —— 工具栏：设备选择 + 配置 —— */}
      <div className="mtp-toolbar">
        <div className="mtp-toolbar-row">
          <label className="mtp-field">
            <span className="mtp-field-label">设备</span>
            <select
              className="mtp-select"
              value={selectedDeviceId ?? ''}
              onChange={(e) => selectDevice(e.target.value)}
              disabled={loadingDevices}
            >
              {devices.length === 0 && <option value="">未检测到设备</option>}
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.storages && d.storages.length > 1
                    ? ` (${d.storages.length} 个存储, ${formatSize(d.freeSpace)} 可用)`
                    : d.freeSpace
                      ? ` (${formatSize(d.freeSpace)} 可用)`
                      : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            className="mtp-btn-icon"
            onClick={() => loadDevices()}
            title="刷新设备列表"
            disabled={loadingDevices}
          >
            <span className={`codicon codicon-refresh ${loadingDevices ? 'codicon-modifier-spin' : ''}`} />
          </button>
        </div>

        <div className="mtp-toolbar-row">
          <label className="mtp-field">
            <span className="mtp-field-label">播放列表</span>
            <select
              className="mtp-select"
              value={selectedPlaylistId ?? ''}
              onChange={(e) => setSelectedPlaylistId(Number(e.target.value))}
            >
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.songCount} 首)
                </option>
              ))}
            </select>
          </label>
          <button
            className={`mtp-btn-icon${batchOpen ? ' mtp-btn-icon-active' : ''}`}
            onClick={() => setBatchOpen((v) => !v)}
            disabled={syncing || playlists.length === 0}
            title="批量勾选多个播放列表一起同步"
          >
            <span className="codicon codicon-checklist" />
          </button>
        </div>

        {batchOpen && (
          <div className="mtp-batch">
            <div className="mtp-batch-header">
              <span>
                批量同步：已选 {batchTargets.length} / {playlists.length} 个播放列表
              </span>
              <span className="mtp-batch-hint">M3U 文件名使用各播放列表名称，其余配置共用</span>
              <button
                className="mtp-batch-link"
                disabled={syncing}
                onClick={() => setBatchPlaylistIds(playlists.map((p) => p.id))}
              >
                全选
              </button>
              <button className="mtp-batch-link" disabled={syncing} onClick={() => setBatchPlaylistIds([])}>
                清空
              </button>
            </div>
            <div className="mtp-batch-list">
              {playlists.map((p) => (
                <label key={p.id} className="mtp-batch-item" title={p.name}>
                  <input
                    type="checkbox"
                    checked={checkedIds.has(p.id)}
                    disabled={syncing}
                    onChange={() => toggleBatchPlaylist(p.id)}
                  />
                  <span className="mtp-batch-name">{p.name}</span>
                  <span className="mtp-batch-count">{p.songCount} 首</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mtp-toolbar-row">
          <label
            className="mtp-field mtp-field-grow"
            title="必填：歌曲文件拷贝到此目录；配置了范例时，M3U 中的路径写法按范例文件"
          >
            <span className="mtp-field-label">
              音乐目录<span className="mtp-field-required">*</span>
            </span>
            <div className="mtp-input-group">
              <input
                className="mtp-input"
                value={remoteMusicDir}
                onChange={(e) => setRemoteMusicDir(e.target.value)}
                placeholder="\Internal storage\Music"
              />
              <button
                className="mtp-btn-browse"
                onClick={() => setBrowsingField('music')}
                disabled={!selectedDeviceId}
                title="浏览设备文件夹"
              >
                <span className="codicon codicon-folder-opened" />
              </button>
            </div>
          </label>
        </div>

        <div className="mtp-toolbar-row">
          <label className="mtp-field mtp-field-grow">
            <span className="mtp-field-label">播放列表目录</span>
            <div className="mtp-input-group">
              <input
                className="mtp-input"
                value={remotePlaylistDir}
                onChange={(e) => setRemotePlaylistDir(e.target.value)}
                placeholder="\Internal storage\Playlists"
              />
              <button
                className="mtp-btn-browse"
                onClick={() => setBrowsingField('playlist')}
                disabled={!selectedDeviceId}
                title="浏览设备文件夹"
              >
                <span className="codicon codicon-folder-opened" />
              </button>
            </div>
          </label>
        </div>

        <div className="mtp-toolbar-row">
          <label className="mtp-field mtp-field-grow">
            <span className="mtp-field-label">M3U 范例文件</span>
            <div className="mtp-input-group">
              <input
                className="mtp-input"
                value={sampleM3uPath}
                onChange={(e) => setSampleM3uPath(e.target.value)}
                placeholder="\内部存储设备\Playlists\example.m3u"
              />
              <button
                className="mtp-btn-browse"
                onClick={() => setBrowsingField('sample')}
                disabled={!selectedDeviceId}
                title="浏览设备上的 M3U 文件（可选，同步时模仿其歌曲路径格式）"
              >
                <span className="codicon codicon-file" />
              </button>
            </div>
          </label>
        </div>

        <div className="mtp-toolbar-row">
          <label className="mtp-field mtp-field-grow">
            <span className="mtp-field-label">M3U 文件名</span>
            <input
              className="mtp-input"
              value={batchMode ? '批量同步时使用各播放列表名称' : playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              disabled={batchMode}
              placeholder="My Playlist"
            />
          </label>
        </div>
      </div>

      {/* —— 错误提示 —— */}
      {deviceError && <div className="mtp-error">{deviceError}</div>}

      {/* —— M3U 歌曲路径写法：范例与音乐目录不一致或范例不可用时由用户选择 —— */}
      {pathPlan && (
        <div className={`mtp-path-plan${pathPlan.needsChoice ? ' mtp-path-plan-warn' : ''}`}>
          <div className="mtp-path-plan-header">
            <span className={`codicon ${pathPlan.needsChoice ? 'codicon-warning' : 'codicon-list-unordered'}`} />
            <span>M3U 歌曲路径写法</span>
            {pathPlan.needsChoice ? (
              <span className="mtp-path-plan-hint">请选择一种写法后再同步</span>
            ) : (
              m3uPathMode && (
                <button
                  className="mtp-path-plan-link"
                  disabled={!canAnalyze}
                  onClick={() => choosePathMode(null)}
                  title="清除手动选择，按范例与音乐目录自动判断"
                >
                  恢复自动判断
                </button>
              )
            )}
          </div>
          {pathPlan.message && <div className="mtp-path-plan-message">{pathPlan.message}</div>}

          <label className={`mtp-path-option${sampleSelectable ? '' : ' mtp-path-option-disabled'}`}>
            <input
              type="radio"
              name="m3u-path-mode"
              checked={pathPlan.mode === 'sample'}
              disabled={!sampleSelectable || !canAnalyze}
              onChange={() => choosePathMode('sample')}
            />
            <span className="mtp-path-option-body">
              <span className="mtp-path-option-title">
                按范例文件
                {pathPlan.sampleMusicRoot && (
                  <span className="mtp-path-option-note">（范例歌曲位于 {pathPlan.sampleMusicRoot}）</span>
                )}
              </span>
              <code className="mtp-path-option-example">
                {pathPlan.sampleExample ?? (pathPlan.sampleError ? `范例不可用：${pathPlan.sampleError}` : '未指定范例文件')}
              </code>
              {pathPlan.sampleExample && pathPlan.sampleError && (
                <span className="mtp-path-option-note">不可用：{pathPlan.sampleError}</span>
              )}
            </span>
          </label>

          <label className="mtp-path-option">
            <input
              type="radio"
              name="m3u-path-mode"
              checked={pathPlan.mode === 'musicDir'}
              disabled={!canAnalyze}
              onChange={() => choosePathMode('musicDir')}
            />
            <span className="mtp-path-option-body">
              <span className="mtp-path-option-title">
                按音乐目录<span className="mtp-path-option-note">（{remoteMusicDir}）</span>
              </span>
              <code className="mtp-path-option-example">{pathPlan.musicDirExample}</code>
            </span>
          </label>

          {/* 内含输入框与按钮，用 div 而非 label，避免点击输入框时误触发单选 */}
          <div className="mtp-path-option">
            <input
              type="radio"
              name="m3u-path-mode"
              checked={pathPlan.mode === 'custom'}
              disabled={!canAnalyze || !customPrefixDraft.trim()}
              onChange={() => choosePathMode('custom')}
            />
            <span className="mtp-path-option-body">
              <span className="mtp-path-option-title">自定义前缀</span>
              <span className="mtp-path-option-custom">
                <input
                  className="mtp-input"
                  value={customPrefixDraft}
                  onChange={(e) => setCustomPrefixDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canAnalyze) choosePathMode('custom');
                  }}
                  placeholder="/storage/XXXX-XXXX/Music/"
                />
                <button
                  className="mtp-btn mtp-btn-secondary"
                  disabled={!canAnalyze || !customPrefixDraft.trim()}
                  onClick={() => choosePathMode('custom')}
                >
                  应用
                </button>
              </span>
              {pathPlan.customExample && customPrefixDraft.trim() === m3uCustomPrefix && (
                <code className="mtp-path-option-example">{pathPlan.customExample}</code>
              )}
            </span>
          </div>

          {pathPlan.sampleMusicRoot && !sameDevicePath(pathPlan.sampleMusicRoot, remoteMusicDir) && (
            <div className="mtp-path-plan-footer">
              <span className="mtp-path-plan-footer-text">
                若播放器的音乐库就在 {pathPlan.sampleMusicRoot}，可把音乐目录改为该目录（歌曲也会上传到这里）。
              </span>
              <button
                className="mtp-btn mtp-btn-secondary"
                disabled={!canAnalyze}
                onClick={() => {
                  setRemoteMusicDir(pathPlan.sampleMusicRoot!);
                  void analyzeDiff(songs);
                }}
              >
                音乐目录改为 {pathPlan.sampleMusicRoot}
              </button>
            </div>
          )}
        </div>
      )}

      {/* —— 双栏 Diff View —— */}
      <div className="mtp-diff-view">
        {/* 左栏：本地待同步列表 */}
        <div className="mtp-diff-col">
          <div className="mtp-diff-col-header">
            <img className="app-logo-img" src={logoUrl} alt="" />
            <span>本地待同步列表</span>
            <span className="mtp-diff-count">{songs.length} 首</span>
          </div>
          <div className="mtp-diff-col-body">
            {songs.length === 0 ? (
              <div className="mtp-diff-empty">选择播放列表以加载歌曲</div>
            ) : (
              songs.map((song, i) => {
                const status = diffMap.get(song.filePath);
                return (
                  <div key={song.id} className="mtp-song-item">
                    <span className="mtp-song-index">{i + 1}</span>
                    <div className="mtp-song-info">
                      <span className="mtp-song-title">{song.title}</span>
                      <span className="mtp-song-artist">{song.artist}</span>
                    </div>
                    {status === 'upload' && <span className="mtp-badge mtp-badge-new">需上传</span>}
                    {status === 'link' && <span className="mtp-badge mtp-badge-link">加入列表</span>}
                    {status === 'exist' && <span className="mtp-badge mtp-badge-exist">无变化</span>}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右栏：设备当前状态 */}
        <div className="mtp-diff-col">
          <div className="mtp-diff-col-header">
            <span className="codicon codicon-device-mobile" />
            <span>设备当前状态</span>
          </div>
          <div className="mtp-diff-col-body">
            {selectedDevice ? (
              <div className="mtp-device-card">
                <div className="mtp-device-row">
                  <span className="mtp-device-label">设备名称</span>
                  <span className="mtp-device-value">{selectedDevice.name}</span>
                </div>
                {selectedDevice.storages && selectedDevice.storages.length > 0 ? (
                  selectedDevice.storages.map((storage, i) => (
                    <div key={i} className="mtp-device-storage">
                      <div className="mtp-device-row">
                        <span className="mtp-device-label">存储</span>
                        <span className="mtp-device-value">{storage.name}</span>
                      </div>
                      <div className="mtp-device-row">
                        <span className="mtp-device-label">总容量</span>
                        <span className="mtp-device-value">{formatSize(storage.totalSpace)}</span>
                      </div>
                      <div className="mtp-device-row">
                        <span className="mtp-device-label">可用空间</span>
                        <span className="mtp-device-value">{formatSize(storage.freeSpace)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <>
                    {selectedDevice.totalSpace > 0 && (
                      <div className="mtp-device-row">
                        <span className="mtp-device-label">总容量</span>
                        <span className="mtp-device-value">{formatSize(selectedDevice.totalSpace)}</span>
                      </div>
                    )}
                    {selectedDevice.freeSpace > 0 && (
                      <div className="mtp-device-row">
                        <span className="mtp-device-label">可用空间</span>
                        <span className="mtp-device-value">{formatSize(selectedDevice.freeSpace)}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="mtp-diff-empty">未选择设备</div>
            )}

            {/* 差异摘要 */}
            {diffResult && (
              <div className="mtp-diff-summary">
                <div className="mtp-diff-summary-header">差异摘要</div>
                <div className="mtp-diff-summary-row">
                  <span className="mtp-badge mtp-badge-new">需上传</span>
                  <span className="mtp-diff-summary-count">{diffResult.toUpload.length} 首</span>
                </div>
                <div className="mtp-diff-summary-row">
                  <span className="mtp-badge mtp-badge-link">加入列表</span>
                  <span className="mtp-diff-summary-count">{linkCount} 首（文件已在设备）</span>
                </div>
                <div className="mtp-diff-summary-row">
                  <span className="mtp-badge mtp-badge-exist">无变化</span>
                  <span className="mtp-diff-summary-count">
                    {diffResult.alreadyExist.length - linkCount} 首
                  </span>
                </div>
                {playlistDiff && playlistDiff.removedEntries.length > 0 && (
                  <div className="mtp-diff-summary-row">
                    <span className="mtp-badge mtp-badge-remove">移出列表</span>
                    <span
                      className="mtp-diff-summary-count"
                      title={playlistDiff.removedEntries.slice(0, 20).join('\n')}
                    >
                      {playlistDiff.removedEntries.length} 首（仅移出播放列表，不删除设备文件）
                    </span>
                  </div>
                )}
                {playlistDiff && (
                  <div className="mtp-diff-summary-note">
                    {!playlistDiff.exists
                      ? `设备上没有 ${playlistFileName}，将新建播放列表`
                      : playlistDiff.identical
                        ? `设备上的 ${playlistFileName} 已是最新，不会重写`
                        : playlistDiff.addedFilePaths.length === 0 && playlistDiff.removedEntries.length === 0
                          ? `${playlistFileName} 条目一致，仅更新顺序`
                          : `将更新设备上的 ${playlistFileName}（+${playlistDiff.addedFilePaths.length} / −${playlistDiff.removedEntries.length}）`}
                  </div>
                )}
                {!playlistDiff && diffResult.pathPlan?.needsChoice && (
                  <div className="mtp-diff-summary-note">选择 M3U 路径写法后才能与设备上的播放列表对比</div>
                )}
              </div>
            )}

            {/* 同步结果 */}
            {syncResult && syncAborted && (
              <div className="mtp-sync-result mtp-sync-result-aborted">
                <div className="mtp-sync-result-header">
                  <span className="codicon codicon-warning" />
                  同步已中止
                </div>
                <div className="mtp-sync-result-row">
                  M3U 歌曲路径写法尚未确定，未上传文件、未写入播放列表。请在上方选择写法后重新同步。
                </div>
              </div>
            )}
            {syncResult && !syncAborted && (
              <div className="mtp-sync-result">
                <div className="mtp-sync-result-header">
                  <span className="codicon codicon-check-all" />
                  同步完成
                </div>
                <div className="mtp-sync-result-row">
                  已上传: <strong>{syncResult.uploaded}</strong> 首
                </div>
                <div className="mtp-sync-result-row">
                  已跳过: <strong>{syncResult.skipped}</strong> 首（设备上已有）
                </div>
                {syncResult.playlistWritten !== undefined && (
                  <div className="mtp-sync-result-row">
                    播放列表:{' '}
                    {syncResult.playlistWritten ? (
                      <>
                        已更新（新增 <strong>{syncResult.playlistAdded ?? 0}</strong>，移出{' '}
                        <strong>{syncResult.playlistRemoved ?? 0}</strong>）
                      </>
                    ) : syncResult.errors.some((e) => e.startsWith('播放列表写入失败')) ? (
                      '写入失败'
                    ) : syncResult.errors.some((e) => e.includes('未写入播放列表')) ? (
                      '未写入（上传中断）'
                    ) : (
                      '无变化，未重写'
                    )}
                  </div>
                )}
                {syncResult.failed > 0 && (
                  <div className="mtp-sync-result-row mtp-sync-result-failed">
                    失败: <strong>{syncResult.failed}</strong> 首
                  </div>
                )}
                {syncResult.errors.length > 0 && (
                  <div className="mtp-sync-errors">
                    {syncResult.errors.slice(0, 5).map((e, idx) => (
                      <div key={idx} className="mtp-sync-error-line">
                        {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 批量同步结果：逐个播放列表的状态 */}
            {batchResults && batchTotals && (
              <div className="mtp-sync-result mtp-batch-result">
                <div className="mtp-sync-result-header">
                  <span
                    className={`codicon ${syncing ? 'codicon-loading codicon-modifier-spin' : 'codicon-check-all'}`}
                  />
                  {syncing ? '批量同步中' : '批量同步结束'}
                  <span className="mtp-batch-total">
                    上传 {batchTotals.uploaded} · 跳过 {batchTotals.skipped}
                    {batchTotals.failed > 0 && ` · 失败 ${batchTotals.failed}`}
                  </span>
                </div>
                {batchResults.map((entry, idx) => {
                  const status = describeBatchEntry(entry, syncing && batchIndex === idx, syncing);
                  const messages = [...(entry.result?.errors ?? []), ...(entry.error ? [entry.error] : [])];
                  return (
                    <div key={entry.playlistId} className="mtp-batch-result-item">
                      <div className="mtp-batch-result-row">
                        <span className="mtp-batch-result-name" title={entry.playlistName}>
                          {entry.playlistName}
                        </span>
                        <span className={`mtp-batch-result-status mtp-batch-result-${status.tone}`}>
                          {status.text}
                        </span>
                      </div>
                      {status.tone !== 'muted' &&
                        messages.slice(0, 3).map((e, i) => (
                          <div key={i} className="mtp-sync-error-line" title={e}>
                            {e}
                          </div>
                        ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* —— 操作栏 + 进度条 —— */}
      <div className="mtp-actions">
        <button
          className="mtp-btn mtp-btn-secondary"
          onClick={() => analyzeDiff(songs)}
          disabled={!canAnalyze}
        >
          <span
            className={`codicon ${diffLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-diff'}`}
          />
          {diffLoading ? '分析中...' : '增量分析 (Analyze Diff)'}
        </button>
        <button
          className="mtp-btn mtp-btn-primary"
          onClick={handleStartSync}
          disabled={!canSync}
        >
          <span
            className={`codicon ${syncing ? 'codicon-loading codicon-modifier-spin' : 'codicon-arrow-circle-up'}`}
          />
          {syncing
            ? '同步中...'
            : batchMode
              ? `同步选中的 ${batchTargets.length} 个播放列表`
              : '开始同步 (Start Sync)'}
        </button>
      </div>

      {/* —— 差异分析进度（递归扫描设备目录，目录多时耗时较长） —— */}
      {diffLoading && (
        <div className="mtp-progress-bar">
          <div className="mtp-progress-info">
            <span className="mtp-progress-phase">正在扫描设备目录</span>
            {diffProgress?.currentFile && (
              <span className="mtp-progress-file" title={diffProgress.currentFile}>
                {diffProgress.currentFile}
              </span>
            )}
            <span>已扫描 {diffProgress?.current ?? 0} 个目录</span>
          </div>
        </div>
      )}

      {diffError && <div className="mtp-error">{diffError}</div>}
      {syncError && <div className="mtp-error">{syncError}</div>}

      {(syncing || syncProgress) && (
        <div className="mtp-progress-bar">
          <div className="mtp-progress-info">
            {syncing && batchIndex !== null && batchResults?.[batchIndex] && (
              <span className="mtp-progress-batch" title={batchResults[batchIndex].playlistName}>
                [{batchIndex + 1}/{batchResults.length}] {batchResults[batchIndex].playlistName}
              </span>
            )}
            <span className="mtp-progress-phase">
              {syncProgress ? PHASE_LABELS[syncProgress.phase] ?? syncProgress.phase : '准备中'}
            </span>
            {syncProgress?.currentFile && (
              <span className="mtp-progress-file" title={syncProgress.currentFile}>
                {syncProgress.currentFile}
              </span>
            )}
            {syncProgress?.speed != null && syncProgress.speed > 0 && (
              <span className="mtp-progress-speed">{formatSpeed(syncProgress.speed)}</span>
            )}
          </div>
          <div className="mtp-progress-track">
            <div
              className="mtp-progress-fill"
              style={{ width: `${syncProgress?.percent ?? 0}%` }}
            />
          </div>
          <div className="mtp-progress-stats">
            <span>
              {syncProgress?.current ?? 0} / {syncProgress?.total ?? songs.length}
            </span>
            <span>{syncProgress?.percent ?? 0}%</span>
          </div>
        </div>
      )}

      {/* —— MTP 文件夹浏览弹窗 —— */}
      {browsingField && selectedDeviceId && (
        <MtpFolderBrowser
          deviceId={selectedDeviceId}
          initialPath={
            browsingField === 'music'
              ? remoteMusicDir
              : browsingField === 'playlist'
                ? remotePlaylistDir
                : // 范例文件浏览：初始定位到范例所在目录，无范例时用播放列表目录
                  sampleM3uPath
                    ? sampleM3uPath.split('\\').slice(0, -1).join('\\') || '\\'
                    : remotePlaylistDir
          }
          mode={browsingField === 'sample' ? 'file' : 'folder'}
          fileExtensions={browsingField === 'sample' ? ['m3u', 'm3u8'] : undefined}
          onSelect={(path) => {
            if (browsingField === 'music') setRemoteMusicDir(path);
            else if (browsingField === 'playlist') setRemotePlaylistDir(path);
            else setSampleM3uPath(path);
            setBrowsingField(null);
          }}
          onClose={() => setBrowsingField(null)}
        />
      )}
    </div>
  );
}
