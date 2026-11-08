import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { useDeviceStore } from '../stores/useDeviceStore';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useSyncStore } from '../stores/useSyncStore';
import { usePlaylistStore } from '../stores/usePlaylistStore';
import { useAiStore } from '../stores/useAiStore';

const SETTINGS_ENTRIES: Array<{
  id: 'appearance' | 'audio' | 'library' | 'device' | 'ai' | 'about';
  icon: string;
  name: string;
}> = [
  { id: 'appearance', icon: 'codicon-color-mode', name: '外观主题' },
  { id: 'audio', icon: 'codicon-pulse', name: '音频输出' },
  { id: 'library', icon: 'codicon-database', name: '音乐库管理' },
  { id: 'device', icon: 'codicon-plug', name: '设备与同步' },
  { id: 'ai', icon: 'codicon-hubot', name: 'AI 服务' },
  { id: 'about', icon: 'codicon-info', name: '关于音枢' },
];

const TITLES: Record<string, string> = {
  library: '资源管理器',
  playlists: '播放列表',
  ai: 'AI 推荐',
  devices: 'MTP 设备',
  settings: '设置',
};

/** 侧边栏 —— 根据活动视图展示文件夹树 / 播放列表 / 设备 / 设置 */
export default function Sidebar() {
  const activeView = useAppStore((s) => s.activeView);

  return (
    <aside className="sidebar">
      <header className="sidebar-header">{TITLES[activeView] ?? ''}</header>
      <div className="sidebar-body">
        {activeView === 'library' && <LibrarySection />}
        {activeView === 'playlists' && <PlaylistsSection />}
        {activeView === 'ai' && <AiSection />}
        {activeView === 'devices' && <DevicesSection />}
        {activeView === 'settings' && <SettingsSection />}
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="sidebar-section-label">{children}</div>;
}

function LibrarySection() {
  const libraryPath = useAppStore((s) => s.libraryPath);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const tracks = useLibraryStore((s) => s.tracks);
  const scanning = useLibraryStore((s) => s.scanning);
  const scanProgress = useLibraryStore((s) => s.scanProgress);
  const viewMode = useAppStore((s) => s.libraryViewMode);
  const setLibraryViewMode = useAppStore((s) => s.setLibraryViewMode);
  const selectedAlbumKey = useAppStore((s) => s.selectedAlbumKey);
  const selectAlbum = useAppStore((s) => s.selectAlbum);
  const search = useLibraryStore((s) => s.search);

  // 从曲目聚合专辑列表（专辑+歌手复合键，同名专辑多歌手分开计）
  const albums = useMemo(() => {
    const map = new Map<string, { key: string; album: string; artist: string; count: number }>();
    for (const t of tracks) {
      const key = `${t.album}::${t.artist}`;
      const cur = map.get(key);
      if (cur) cur.count++;
      else map.set(key, { key, album: t.album, artist: t.artist, count: 1 });
    }
    return [...map.values()].sort((a, b) => a.album.localeCompare(b.album, 'zh-CN'));
  }, [tracks]);

  // 双击专辑：按曲目序号顺序播放整张专辑
  const playAlbum = (key: string) => {
    const songs = tracks
      .filter((t) => `${t.album}::${t.artist}` === key)
      .sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
    if (songs.length > 0) playTrack(songs[0], songs);
  };

  // 从路径提取最后一级目录名
  const folderName = libraryPath?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <>
      <SectionLabel>展示维度</SectionLabel>
      <div className="library-view-switch">
        <button
          className={`library-view-btn ${viewMode === 'songs' ? 'active' : ''}`}
          onClick={() => setLibraryViewMode('songs')}
          title="按歌曲维度展示"
        >
          <span className="codicon codicon-list-flat" />
          歌曲
        </button>
        <button
          className={`library-view-btn ${viewMode === 'albums' ? 'active' : ''}`}
          onClick={() => setLibraryViewMode('albums')}
          title="按专辑维度展示"
        >
          <span className="codicon codicon-disc" />
          专辑
        </button>
      </div>

      {viewMode === 'songs' ? (
        <>
          <SectionLabel>文件夹</SectionLabel>
          {folderName ? (
            <button
              className="sidebar-tree-item"
              onDoubleClick={() => tracks[0] && playTrack(tracks[0], tracks)}
              title="双击播放全部"
            >
              <span className="codicon codicon-folder" />
              <span className="sidebar-tree-label">{folderName}</span>
              <span className="sidebar-tree-count">{tracks.length}</span>
            </button>
          ) : (
            <div className="sidebar-scan-status">尚未选择音乐库目录（设置 → 音乐库管理）</div>
          )}
        </>
      ) : (
        <>
          <SectionLabel>专辑</SectionLabel>
          {albums.length === 0 && (
            <div className="sidebar-scan-status">
              {search ? `未找到与「${search}」匹配的专辑` : '暂无专辑，请先扫描音乐库'}
            </div>
          )}
          {albums.map((a) => (
            <button
              key={a.key}
              className={`sidebar-tree-item album ${selectedAlbumKey === a.key ? 'active' : ''}`}
              onClick={() => selectAlbum(selectedAlbumKey === a.key ? null : a.key)}
              onDoubleClick={() => playAlbum(a.key)}
              title="单击选中，双击播放整张专辑"
            >
              <span className="codicon codicon-disc" />
              <span className="sidebar-tree-label">{a.album}</span>
              <span className="sidebar-tree-count">{a.count}</span>
            </button>
          ))}
        </>
      )}

      {scanning && scanProgress && (
        <div className="sidebar-scan-status">
          {scanProgress.phase === 'scanning' && `正在扫描文件 ${scanProgress.current}...`}
          {scanProgress.phase === 'parsing' &&
            `解析元数据 ${scanProgress.current}/${scanProgress.total}`}
          {scanProgress.currentFile && (
            <div className="sidebar-scan-file" title={scanProgress.currentFile}>
              {scanProgress.currentFile}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PlaylistsSection() {
  const playlists = usePlaylistStore((s) => s.playlists);
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId);
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists);
  const createPlaylist = usePlaylistStore((s) => s.createPlaylist);
  const deletePlaylist = usePlaylistStore((s) => s.deletePlaylist);
  const renamePlaylist = usePlaylistStore((s) => s.renamePlaylist);
  const selectPlaylist = usePlaylistStore((s) => s.selectPlaylist);
  const playPlaylist = usePlaylistStore((s) => s.playPlaylist);
  const importM3u = usePlaylistStore((s) => s.importM3u);

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    loadPlaylists();
  }, []);

  const handleCreate = () => {
    if (newName.trim()) {
      createPlaylist(newName);
      setNewName('');
    }
  };

  const handleRename = (id: number) => {
    if (editName.trim()) renamePlaylist(id, editName);
    setEditingId(null);
  };

  const handleImportM3u = async () => {
    setImporting(true);
    setImportMsg('');
    try {
      const result = await importM3u();
      if (result) {
        setImportMsg(`「${result.name}」已导入，匹配 ${result.matched}/${result.total} 首`);
      }
    } finally {
      setImporting(false);
      setTimeout(() => setImportMsg(''), 5000);
    }
  };

  return (
    <>
      <SectionLabel>播放列表</SectionLabel>
      <div className="sidebar-playlist-create">
        <input
          className="sidebar-playlist-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="新建播放列表..."
        />
        <button className="sidebar-playlist-add" onClick={handleCreate} title="创建播放列表">
          <span className="codicon codicon-add" />
        </button>
      </div>
      <button
        className="sidebar-action"
        onClick={handleImportM3u}
        disabled={importing}
        title="从 M3U 文件导入播放列表"
      >
        <span className={`codicon codicon-new-file ${importing ? 'codicon-modifier-spin' : ''}`} />
        <span className="sidebar-action-label">{importing ? '导入中...' : '导入 M3U 文件'}</span>
      </button>
      {importMsg && <div className="sidebar-scan-status">{importMsg}</div>}
      {playlists.map((p) => (
        <div
          key={p.id}
          className={`sidebar-tree-item ${selectedPlaylistId === p.id ? 'active' : ''}`}
          onClick={() => selectPlaylist(p.id)}
          onDoubleClick={() => {
            selectPlaylist(p.id);
            playPlaylist();
          }}
          title="单击选中，双击播放"
        >
          <span className="codicon codicon-list-selection" />
          {editingId === p.id ? (
            <input
              className="sidebar-playlist-rename"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={() => handleRename(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename(p.id);
                if (e.key === 'Escape') setEditingId(null);
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="sidebar-tree-label">{p.name}</span>
          )}
          <span className="sidebar-tree-count">{p.songCount}</span>
          <button
            className="sidebar-tree-action"
            onClick={(e) => {
              e.stopPropagation();
              deletePlaylist(p.id);
            }}
            title="删除播放列表"
          >
            <span className="codicon codicon-close" />
          </button>
        </div>
      ))}
      {playlists.length === 0 && !newName && (
        <div className="sidebar-scan-status">暂无播放列表，上方输入名称创建</div>
      )}
    </>
  );
}

/** AI 推荐视图侧边栏：服务状态 + 关联播放列表 + 快捷指令 */
function AiSection() {
  const config = useAiStore((s) => s.config);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const linkedPlaylistId = useAiStore((s) => s.linkedPlaylistId);
  const linkedSongs = useAiStore((s) => s.linkedSongs);
  const setLinkedPlaylist = useAiStore((s) => s.setLinkedPlaylist);
  const send = useAiStore((s) => s.send);
  const streaming = useAiStore((s) => s.streaming);
  const playlists = usePlaylistStore((s) => s.playlists);
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  // 首次挂载：加载配置/播放列表，恢复关联列表的歌曲快照
  useEffect(() => {
    loadConfig();
    loadPlaylists();
    const id = useAiStore.getState().linkedPlaylistId;
    if (id !== null) setLinkedPlaylist(id);
  }, []);

  /** apiKey 是唯一必填项（地址/模型有默认值） */
  const configured = !!config && config.apiKey.trim() !== '';
  const hasLinked = linkedPlaylistId !== null && linkedSongs.length > 0;

  /** 发送快捷指令（侧边栏仅在 AI 视图下可见，无需切视图） */
  const quickSend = (text: string) => {
    if (!streaming) send(text);
  };

  return (
    <>
      <SectionLabel>AI 服务</SectionLabel>
      {configured ? (
        <div className="sidebar-ai-status ok" title={`模型：${config?.model}`}>
          <span className="codicon codicon-pass" />
          <span className="sidebar-ai-model">{config?.model}</span>
        </div>
      ) : (
        <button className="sidebar-action" onClick={() => setSettingsSection('ai')}>
          <span className="codicon codicon-warning" />
          <span className="sidebar-action-label">未配置，去设置</span>
        </button>
      )}

      <SectionLabel>关联播放列表</SectionLabel>
      <button
        className={`sidebar-tree-item ${linkedPlaylistId === null ? 'active' : ''}`}
        onClick={() => setLinkedPlaylist(null)}
        title="不关联任何播放列表"
      >
        <span className="codicon codicon-clear-all" />
        <span className="sidebar-tree-label">不关联</span>
      </button>
      {playlists.map((p) => (
        <button
          key={p.id}
          className={`sidebar-tree-item ${linkedPlaylistId === p.id ? 'active' : ''}`}
          onClick={() => setLinkedPlaylist(p.id)}
          title="点击关联，AI 将分析列表内歌曲"
        >
          <span className="codicon codicon-list-selection" />
          <span className="sidebar-tree-label">{p.name}</span>
          <span className="sidebar-tree-count">{p.songCount}</span>
        </button>
      ))}
      {playlists.length === 0 && (
        <div className="sidebar-scan-status">暂无播放列表，可到「播放列表」视图创建</div>
      )}

      {hasLinked && (
        <>
          <SectionLabel>快捷指令</SectionLabel>
          <button
            className="sidebar-action"
            onClick={() => quickSend('分析这个播放列表的曲风、歌手、作曲人等特征')}
            disabled={streaming}
          >
            <span className="codicon codicon-graph" />
            <span className="sidebar-action-label">分析列表特征</span>
          </button>
          <button
            className="sidebar-action"
            onClick={() => quickSend('根据我的口味推荐 10 首相似的歌曲')}
            disabled={streaming}
          >
            <span className="codicon codicon-lightbulb" />
            <span className="sidebar-action-label">推荐相似歌曲</span>
          </button>
        </>
      )}
    </>
  );
}

function DevicesSection() {
  const connected = useDeviceStore((s) => s.connected);
  const deviceName = useDeviceStore((s) => s.deviceName);
  const storages = useDeviceStore((s) => s.storages);
  const freeSpaceGB = useDeviceStore((s) => s.freeSpaceGB);
  const totalSpaceGB = useDeviceStore((s) => s.totalSpaceGB);
  const loadDevices = useSyncStore((s) => s.loadDevices);
  const loadingDevices = useSyncStore((s) => s.loadingDevices);
  const deviceSubview = useAppStore((s) => s.deviceSubview);
  const setDeviceSubview = useAppStore((s) => s.setDeviceSubview);
  const activeView = useAppStore((s) => s.activeView);

  function formatGB(bytes: number): string {
    return `${Math.round((bytes / 1073741824) * 10) / 10} GB`;
  }

  return (
    <>
      <SectionLabel>已连接设备</SectionLabel>
      <div className={`sidebar-device ${connected ? 'connected' : 'disconnected'}`}>
        <span className="codicon codicon-device-mobile" />
        <div className="sidebar-device-info">
          <span className="sidebar-device-name">
            {connected ? (deviceName || '播放器') : '未连接设备'}
          </span>
          {connected && storages.length > 0 ? (
            storages.map((s, i) => (
              <span key={i} className="sidebar-device-meta">
                {s.name}：{formatGB(s.freeSpace)} / {formatGB(s.totalSpace)}
              </span>
            ))
          ) : connected ? (
            <span className="sidebar-device-meta">
              剩余 {freeSpaceGB} GB / 共 {totalSpaceGB} GB
            </span>
          ) : null}
        </div>
      </div>
      <SectionLabel>操作</SectionLabel>
      <button className="sidebar-action" onClick={() => loadDevices()} disabled={loadingDevices}>
        <span className={`codicon codicon-refresh ${loadingDevices ? 'codicon-modifier-spin' : ''}`} />
        <span className="sidebar-action-label">{loadingDevices ? '扫描中...' : '刷新设备'}</span>
      </button>
      <button
        className={`sidebar-action ${deviceSubview === 'sync' && activeView === 'devices' ? 'active' : ''}`}
        onClick={() => setDeviceSubview('sync')}
      >
        <span className="codicon codicon-arrow-circle-up" />
        <span className="sidebar-action-label">同步到设备</span>
      </button>
      <button
        className={`sidebar-action ${deviceSubview === 'manage' && activeView === 'devices' ? 'active' : ''}`}
        onClick={() => setDeviceSubview('manage')}
      >
        <span className="codicon codicon-trash" />
        <span className="sidebar-action-label">管理设备文件</span>
      </button>
    </>
  );
}

function SettingsSection() {
  const settingsSection = useAppStore((s) => s.settingsSection);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  return (
    <>
      <SectionLabel>设置</SectionLabel>
      {SETTINGS_ENTRIES.map((s) => (
        <button
          key={s.id}
          className={`sidebar-tree-item ${settingsSection === s.id ? 'active' : ''}`}
          onClick={() => setSettingsSection(s.id)}
        >
          <span className={`codicon ${s.icon}`} />
          <span className="sidebar-tree-label">{s.name}</span>
        </button>
      ))}
    </>
  );
}
