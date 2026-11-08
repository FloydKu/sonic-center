import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useLibraryStore, getSavedLibraryPath, type LibrarySortBy } from '../stores/useLibraryStore';
import { usePlaylistStore } from '../stores/usePlaylistStore';
import TabBar from './TabBar';
import VirtualTrackTable from './VirtualTrackTable';
import MtpSyncPanel from './MtpSyncPanel';
import MtpDeviceManager from './MtpDeviceManager';
import SettingsPanel from './SettingsPanel';
import AiChatPanel from './AiChatPanel';

/** 主视图 —— 顶部 Tab 标签页 + 内容区 */
export default function MainView() {
  const activeView = useAppStore((s) => s.activeView);
  const tracks = useLibraryStore((s) => s.tracks);
  const loading = useLibraryStore((s) => s.loading);
  const scanning = useLibraryStore((s) => s.scanning);
  const error = useLibraryStore((s) => s.error);
  const loadSongs = useLibraryStore((s) => s.loadSongs);
  const scanAndLoad = useLibraryStore((s) => s.scanAndLoad);
  const playlistTracks = usePlaylistStore((s) => s.playlistTracks);
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId);
  const addToPlaylistMode = usePlaylistStore((s) => s.addToPlaylistMode);
  const enterAddMode = usePlaylistStore((s) => s.enterAddMode);
  const exitAddMode = usePlaylistStore((s) => s.exitAddMode);
  const addSongsToPlaylist = usePlaylistStore((s) => s.addSongsToPlaylist);
  const deviceSubview = useAppStore((s) => s.deviceSubview);
  const libraryViewMode = useAppStore((s) => s.libraryViewMode);
  const selectedAlbumKey = useAppStore((s) => s.selectedAlbumKey);
  const search = useLibraryStore((s) => s.search);

  // 专辑模式下当前选中专辑的曲目（按曲目序号排序）
  const albumTracks = useMemo(() => {
    if (!selectedAlbumKey) return [];
    return tracks
      .filter((t) => `${t.album}::${t.artist}` === selectedAlbumKey)
      .sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
  }, [tracks, selectedAlbumKey]);

  // 选中专辑的封面（专辑内逐首尝试取封面，一般第一首就有；最多试前 5 首）
  const [albumCoverUrl, setAlbumCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAlbumCoverUrl(null);
    if (!selectedAlbumKey || albumTracks.length === 0) return;
    (async () => {
      for (const t of albumTracks.slice(0, 5)) {
        try {
          const cover = await window.api?.getCover(t.id);
          if (cover) {
            if (!cancelled) setAlbumCoverUrl(`data:${cover.mime};base64,${cover.base64}`);
            return;
          }
        } catch {
          // 单曲封面读取失败继续尝试下一首
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAlbumKey, albumTracks]);

  // 当前选中专辑的信息（专辑名/歌手）
  const albumInfo = useMemo(() => {
    const first = albumTracks[0];
    return first ? { album: first.album, artist: first.artist } : null;
  }, [albumTracks]);

  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const selectedTrackPaths = useAppStore((s) => s.selectedTrackPaths);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const setTagEditorVisible = useAppStore((s) => s.setTagEditorVisible);

  const handleConfirmAdd = async () => {
    if (selectedPlaylistId === null) return;
    const songIds = tracks
      .filter((t) => selectedTrackPaths.includes(t.filePath))
      .map((t) => t.id);
    if (songIds.length > 0) {
      await addSongsToPlaylist(selectedPlaylistId, songIds);
    }
    clearSelection();
    exitAddMode();
  };

  const handleCancelAdd = () => {
    clearSelection();
    exitAddMode();
  };

  // 启动时加载库内歌曲；若有上次记住的目录则恢复路径并自动增量扫描
  useEffect(() => {
    loadSongs();
    const saved = getSavedLibraryPath();
    if (saved) {
      setLibraryPath(saved);
      scanAndLoad(saved);
    }
  }, []);

  return (
    <main className="main-view">
      <TabBar />
      <div className="main-view-content">
        {activeView === 'library' && (
          <>
            {scanning && (
              <div className="library-scan-hint">
                <span className="codicon codicon-sync codicon-modifier-spin" />
                正在扫描音乐库...
              </div>
            )}
            {error && <div className="library-scan-hint error">加载失败：{error}</div>}
            {/* 有曲目/加载中/正在搜索时显示工具栏（搜索无结果也保留，否则无法清空搜索词） */}
            {(tracks.length > 0 || loading || search !== '') && <LibrarySortToolbar />}
            {libraryViewMode === 'songs' ? (
              <>
                {(tracks.length > 0 || loading) && <VirtualTrackTable tracks={tracks} />}
                {!scanning && !loading && tracks.length === 0 && (
                  <EmptyView
                    icon="codicon-folder-opened"
                    text={
                      search
                        ? `未找到与「${search}」匹配的歌曲`
                        : '音乐库为空，请到 设置 → 音乐库管理 选择源目录'
                    }
                  />
                )}
              </>
            ) : selectedAlbumKey && albumTracks.length > 0 ? (
              <>
                <div className="library-album-header">
                  {albumCoverUrl ? (
                    <img
                      className="library-album-cover"
                      src={albumCoverUrl}
                      alt={albumInfo?.album}
                    />
                  ) : (
                    <div className="library-album-cover placeholder">
                      <span className="codicon codicon-disc" />
                    </div>
                  )}
                  <div className="library-album-info">
                    <span className="library-album-name">{albumInfo?.album}</span>
                    <span className="library-album-artist">
                      {albumInfo?.artist} · {albumTracks.length} 首
                    </span>
                  </div>
                </div>
                <VirtualTrackTable tracks={albumTracks} />
              </>
            ) : (
              <EmptyView icon="codicon-disc" text="选择左侧专辑以查看曲目" />
            )}
          </>
        )}
        {activeView === 'playlists' && (
          <>
            {selectedPlaylistId !== null && (
              <div className="playlist-toolbar">
                {addToPlaylistMode ? (
                  <>
                    <span className="playlist-toolbar-hint">
                      勾选要添加的歌曲，已选 {selectedTrackPaths.length} 首
                    </span>
                    <button
                      className="playlist-btn playlist-btn-primary"
                      onClick={handleConfirmAdd}
                      disabled={selectedTrackPaths.length === 0}
                    >
                      <span className="codicon codicon-check" />
                      确认添加
                    </button>
                    <button className="playlist-btn" onClick={handleCancelAdd}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="playlist-btn playlist-btn-primary" onClick={enterAddMode}>
                    <span className="codicon codicon-add" />
                    添加歌曲
                  </button>
                )}
              </div>
            )}
            {addToPlaylistMode && selectedPlaylistId !== null ? (
              <VirtualTrackTable tracks={tracks} showCheckboxes />
            ) : playlistTracks.length > 0 ? (
              <VirtualTrackTable tracks={playlistTracks} contextPlaylistId={selectedPlaylistId} />
            ) : (
              <EmptyView icon="codicon-list-ordered" text="选择左侧播放列表以查看曲目" />
            )}
          </>
        )}
        {activeView === 'ai' && <AiChatPanel />}
        {activeView === 'devices' &&
          (deviceSubview === 'manage' ? <MtpDeviceManager /> : <MtpSyncPanel />)}
        {activeView === 'settings' && <SettingsPanel />}
      </div>
    </main>
  );
}

function EmptyView({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="view-empty">
      <span className={`codicon ${icon} view-empty-icon`} />
      <p className="view-empty-text">{text}</p>
    </div>
  );
}

const SORT_LABELS: Record<LibrarySortBy, string> = {
  title: '名称',
  artist: '歌手',
  album: '专辑',
  added: '添加时间',
};

/** 音乐库工具栏：排序方式下拉 + 升/降序切换 + 搜索框（专辑维度仅显示搜索） */
function LibrarySortToolbar() {
  const sortBy = useLibraryStore((s) => s.sortBy);
  const sortDir = useLibraryStore((s) => s.sortDir);
  const setSort = useLibraryStore((s) => s.setSort);
  const search = useLibraryStore((s) => s.search);
  const setSearch = useLibraryStore((s) => s.setSearch);
  const viewMode = useAppStore((s) => s.libraryViewMode);

  return (
    <div className="library-toolbar">
      {viewMode === 'songs' && (
        <>
          <span className="library-toolbar-label">
            <span className="codicon codicon-sort-precedence" />
            排序
          </span>
          <select
            className="library-sort-select"
            value={sortBy}
            onChange={(e) => setSort(e.target.value as LibrarySortBy)}
            title="选择排序方式"
          >
            {(Object.keys(SORT_LABELS) as LibrarySortBy[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
          <button
            className="playlist-btn library-sort-dir"
            onClick={() => setSort(sortBy)}
            title={sortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'}
          >
            <span className={`codicon ${sortDir === 'asc' ? 'codicon-arrow-up' : 'codicon-arrow-down'}`} />
            {sortDir === 'asc' ? '升序' : '降序'}
          </button>
        </>
      )}
      <div className="library-toolbar-search">
        <span className="codicon codicon-search" />
        <input
          className="library-search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索歌名、歌手、专辑..."
          title="模糊搜索歌名 / 歌手 / 专辑"
        />
        {search && (
          <button
            className="library-search-clear"
            onClick={() => setSearch('')}
            title="清空搜索"
          >
            <span className="codicon codicon-close" />
          </button>
        )}
      </div>
    </div>
  );
}
