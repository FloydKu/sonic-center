import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import type { MouseEvent } from 'react';
import type { Track } from '../types';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useAppStore } from '../stores/useAppStore';
import { usePlaylistStore } from '../stores/usePlaylistStore';

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const CHECKBOX_WIDTH = 36;

interface Column {
  key: string;
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

const COLUMNS: Column[] = [
  { key: 'index', label: '#', width: 56, align: 'center' },
  { key: 'title', label: '标题', width: 320 },
  { key: 'artist', label: '歌手', width: 200 },
  { key: 'album', label: '专辑', width: 220 },
  { key: 'duration', label: '时长', width: 90, align: 'right' },
  { key: 'bitrate', label: '比特率', width: 110, align: 'right' },
];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface VirtualTrackTableProps {
  tracks: Track[];
  /** 显示勾选框（用于批量添加歌曲模式） */
  showCheckboxes?: boolean;
  /** 当前查看的播放列表 ID（设置后右键菜单显示"从播放列表移除"） */
  contextPlaylistId?: number | null;
}

/** 虚拟滚动表格 —— 仅渲染可视区域行 + overscan，可流畅展示万级曲目 */
export default function VirtualTrackTable({ tracks, showCheckboxes, contextPlaylistId }: VirtualTrackTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  const playlists = usePlaylistStore((s) => s.playlists);
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists);
  const addSongsToPlaylist = usePlaylistStore((s) => s.addSongsToPlaylist);
  const removeSongFromPlaylist = usePlaylistStore((s) => s.removeSongFromPlaylist);
  const selectedTrackPaths = useAppStore((s) => s.selectedTrackPaths);
  const setSelectedTrackPaths = useAppStore((s) => s.setSelectedTrackPaths);

  // 右键菜单打开时确保播放列表已加载
  useEffect(() => {
    if (contextMenu && playlists.length === 0) loadPlaylists();
  }, [contextMenu, playlists.length, loadPlaylists]);

  // Escape 关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setContextMenu(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  const handleAddToPlaylist = async (playlistId: number) => {
    if (!contextMenu) return;
    const songsToAdd = selectedTrackPaths.includes(contextMenu.track.filePath)
      ? tracks.filter((t) => selectedTrackPaths.includes(t.filePath))
      : [contextMenu.track];
    await addSongsToPlaylist(playlistId, songsToAdd.map((t) => t.id));
    setContextMenu(null);
  };

  const handleRemoveFromPlaylist = async () => {
    if (!contextMenu || contextPlaylistId == null) return;
    await removeSongFromPlaylist(contextPlaylistId, contextMenu.track.id);
    setContextMenu(null);
  };

  // 勾选框模式下的全选/取消全选
  const allSelected = !!showCheckboxes && tracks.length > 0 && tracks.every((t) => selectedTrackPaths.includes(t.filePath));
  const someSelected = !!showCheckboxes && !allSelected && tracks.some((t) => selectedTrackPaths.includes(t.filePath));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedTrackPaths([]);
    } else {
      setSelectedTrackPaths(tracks.map((t) => t.filePath));
    }
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalHeight = tracks.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(tracks.length, startIndex + visibleCount);
  const visible = tracks.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  return (
    <div className="track-table">
      <div className="track-table-header">
        {showCheckboxes && (
          <div className="track-table-cell header center" style={{ width: CHECKBOX_WIDTH }}>
            <input
              type="checkbox"
              className="track-checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleSelectAll}
            />
          </div>
        )}
        {COLUMNS.map((col) => (
          <div
            key={col.key}
            className={`track-table-cell header ${col.align ?? 'left'}`}
            style={{ width: col.width }}
          >
            {col.label}
          </div>
        ))}
        <div className="track-table-cell-spacer" />
      </div>
      <div
        className="track-table-body"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visible.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                index={startIndex + i}
                columns={COLUMNS}
                onPlay={(t) => usePlayerStore.getState().playTrack(t, tracks)}
                allTracks={tracks}
                onContextMenu={(e, track) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, track });
                }}
                showCheckboxes={showCheckboxes}
              />
            ))}
          </div>
        </div>
      </div>
      {contextMenu && (
        <>
          <div className="ctx-menu-overlay" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
          <div
            className="ctx-menu"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 240), top: Math.min(contextMenu.y, window.innerHeight - 360) }}
          >
            <div className="ctx-menu-item" onClick={() => {
              usePlayerStore.getState().playTrack(contextMenu.track, tracks);
              setContextMenu(null);
            }}>
              <span className="codicon codicon-play" />
              播放
            </div>
            {contextPlaylistId != null && (
              <>
                <div className="ctx-menu-sep" />
                <div className="ctx-menu-item danger" onClick={handleRemoveFromPlaylist}>
                  <span className="codicon codicon-trash" />
                  从播放列表移除
                </div>
              </>
            )}
            <div className="ctx-menu-sep" />
            <div className="ctx-menu-label">添加到播放列表</div>
            {playlists.length === 0 && (
              <div className="ctx-menu-item disabled">暂无播放列表</div>
            )}
            {playlists.map((p) => (
              <div key={p.id} className="ctx-menu-item" onClick={() => handleAddToPlaylist(p.id)}>
                <span className="codicon codicon-list-selection" />
                {p.name}
                <span className="ctx-menu-count">{p.songCount}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TrackRow({
  track,
  index,
  columns,
  onPlay,
  allTracks,
  onContextMenu,
  showCheckboxes,
}: {
  track: Track;
  index: number;
  columns: Column[];
  onPlay: (track: Track) => void;
  allTracks: Track[];
  onContextMenu: (e: MouseEvent, track: Track) => void;
  showCheckboxes?: boolean;
}) {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentId = usePlayerStore((s) =>
    s.currentIndex >= 0 ? s.queue[s.currentIndex]?.id : undefined,
  );
  const isCurrent = currentId === track.id;

  const selectedPaths = useAppStore((s) => s.selectedTrackPaths);
  const setSelectedTrackPaths = useAppStore((s) => s.setSelectedTrackPaths);
  const setTagEditorVisible = useAppStore((s) => s.setTagEditorVisible);
  const isSelected = selectedPaths.includes(track.filePath);

  // 勾选框模式：点击行切换勾选状态
  const handleClick = (e: MouseEvent) => {
    if (showCheckboxes) {
      const has = selectedPaths.includes(track.filePath);
      const next = has
        ? selectedPaths.filter((p) => p !== track.filePath)
        : [...selectedPaths, track.filePath];
      setSelectedTrackPaths(next);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const has = selectedPaths.includes(track.filePath);
      const next = has
        ? selectedPaths.filter((p) => p !== track.filePath)
        : [...selectedPaths, track.filePath];
      setSelectedTrackPaths(next);
    } else if (e.shiftKey && selectedPaths.length > 0) {
      const lastPath = selectedPaths[selectedPaths.length - 1];
      const lastIdx = allTracks.findIndex((t) => t.filePath === lastPath);
      if (lastIdx >= 0) {
        const lo = Math.min(lastIdx, index);
        const hi = Math.max(lastIdx, index);
        setSelectedTrackPaths(allTracks.slice(lo, hi + 1).map((t) => t.filePath));
      }
    } else {
      setSelectedTrackPaths([track.filePath]);
    }
    setTagEditorVisible(true);
  };

  const toggleCheckbox = (e: MouseEvent) => {
    e.stopPropagation();
    const has = selectedPaths.includes(track.filePath);
    const next = has
      ? selectedPaths.filter((p) => p !== track.filePath)
      : [...selectedPaths, track.filePath];
    setSelectedTrackPaths(next);
  };

  const renderCell = (col: Column) => {
    switch (col.key) {
      case 'index':
        if (isCurrent && isPlaying) {
          return (
            <span className="eq-bars" title="正在播放">
              <i />
              <i />
              <i />
            </span>
          );
        }
        return (
          <>
            <span className="track-index">{index + 1}</span>
            <span className="codicon codicon-play track-hover-play" />
          </>
        );
      case 'title':
        return <span className={`track-title ${isCurrent ? 'active' : ''}`}>{track.title}</span>;
      case 'artist':
        return <span className="track-artist">{track.artist}</span>;
      case 'album':
        return <span className="track-album">{track.album}</span>;
      case 'duration':
        return formatTime(track.duration);
      case 'bitrate': {
        const isLossless = track.format === 'flac' || track.bitrate >= 100000;
        const kbps = track.bitrate >= 100000 ? Math.round(track.bitrate / 1000) : track.bitrate;
        return (
          <span className={`track-bitrate ${isLossless ? 'lossless' : ''}`}>
            {isLossless ? 'FLAC' : `${kbps} kbps`}
          </span>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div
      className={`track-table-row ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''} ${index % 2 ? 'odd' : 'even'}`}
      style={{ height: ROW_HEIGHT }}
      onClick={handleClick}
      onDoubleClick={() => onPlay(track)}
      onContextMenu={(e) => onContextMenu(e, track)}
      title="单击选中 · 双击播放 · 右键菜单"
    >
      {showCheckboxes && (
        <div className="track-table-cell center" style={{ width: CHECKBOX_WIDTH }}>
          <input
            type="checkbox"
            className="track-checkbox"
            checked={isSelected}
            onClick={toggleCheckbox}
            onChange={() => {}}
          />
        </div>
      )}
      {columns.map((col) => (
        <div
          key={col.key}
          className={`track-table-cell ${col.align ?? 'left'}`}
          style={{ width: col.width }}
        >
          {renderCell(col)}
        </div>
      ))}
      <div className="track-table-cell-spacer" />
    </div>
  );
}
