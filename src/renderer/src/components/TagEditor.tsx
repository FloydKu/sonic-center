import { useEffect, useState, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import type { Track } from '../types';
import type { TagUpdate } from '@/shared/types';

/**
 * Tag 编辑器 (Properties Inspector) —— 右侧属性面板
 * 支持单选 / 多选编辑：选中一首歌时显示完整元数据与封面预览，
 * 选中多首时允许批量修改共同字段。
 */
export default function TagEditor({ tracks }: { tracks: Track[] }) {
  const selectedPaths = useAppStore((s) => s.selectedTrackPaths);
  const tagEditorVisible = useAppStore((s) => s.tagEditorVisible);
  const setTagEditorVisible = useAppStore((s) => s.setTagEditorVisible);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const loadSongs = useLibraryStore((s) => s.loadSongs);

  // 当前选中的 Track 对象
  const selectedTracks = tracks.filter((t) => selectedPaths.includes(t.filePath));
  const isMulti = selectedTracks.length > 1;
  const single = selectedTracks.length === 1 ? selectedTracks[0] : null;

  // 编辑态字段
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [newCoverBase64, setNewCoverBase64] = useState<string | null>(null);
  const [newCoverMime, setNewCoverMime] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 选中曲目变化时加载字段
  useEffect(() => {
    if (selectedTracks.length === 0) return;
    if (isMulti) {
      // 多选：检查字段是否一致
      const titles = new Set(selectedTracks.map((t) => t.title));
      const artists = new Set(selectedTracks.map((t) => t.artist));
      const albums = new Set(selectedTracks.map((t) => t.album));
      setTitle(titles.size === 1 ? [...titles][0] : '');
      setArtist(artists.size === 1 ? [...artists][0] : '');
      setAlbum(albums.size === 1 ? [...albums][0] : '');
    } else if (single) {
      setTitle(single.title);
      setArtist(single.artist);
      setAlbum(single.album);
    }
    setNewCoverBase64(null);
    setNewCoverMime(null);
    setSaveMsg(null);

    // 加载封面 (仅单选时)
    loadCover();
  }, [selectedPaths.join(',')]);

  async function loadCover() {
    setCoverUrl(null);
    if (!single || !window.api) return;
    try {
      setLoading(true);
      const cover = await window.api.getCover(single.id);
      if (cover) {
        setCoverUrl(`data:${cover.mime};base64,${cover.base64}`);
      }
    } catch {
      // 封面读取失败静默处理
    } finally {
      setLoading(false);
    }
  }

  // 点击封面 → 触发文件选择
  function handleCoverClick() {
    fileInputRef.current?.click();
  }

  // 选择新封面图片
  function handleCoverChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      const mime = result.split(',')[0].split(':')[1].split(';')[0];
      setNewCoverBase64(base64);
      setNewCoverMime(mime);
      setCoverUrl(result); // 立即预览
    };
    reader.readAsDataURL(file);
  }

  // 保存 Tag
  async function handleSave() {
    if (selectedTracks.length === 0 || !window.api) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const update: TagUpdate = {};
      if (title) update.title = title;
      if (artist) update.artist = artist;
      if (album) update.album = album;
      if (newCoverBase64 !== null) {
        update.coverBase64 = newCoverBase64;
        update.coverMime = newCoverMime ?? 'image/jpeg';
      }

      let ok = 0;
      let fail = 0;
      let failReason = '';
      for (const track of selectedTracks) {
        try {
          await window.api.updateTag(track.filePath, update);
          ok++;
        } catch (err) {
          fail++;
          if (!failReason) failReason = err instanceof Error ? err.message : String(err);
        }
      }

      if (fail === 0) {
        setSaveMsg({ type: 'ok', text: `已保存 ${ok} 首歌曲的标签` });
        // 刷新列表，让表格/侧栏立即显示新元数据
        void loadSongs();
      } else {
        setSaveMsg({
          type: 'err',
          text: `成功 ${ok} 首，失败 ${fail} 首${failReason ? `：${failReason}` : ''}`,
        });
      }
      setNewCoverBase64(null);
    } catch (err) {
      setSaveMsg({
        type: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setTagEditorVisible(false);
    clearSelection();
  }

  if (!tagEditorVisible || selectedTracks.length === 0) return null;

  return (
    <aside className="tag-editor">
      {/* —— 头部 —— */}
      <div className="tag-editor-header">
        <span className="tag-editor-title">
          {isMulti ? `属性 (${selectedTracks.length} 首)` : '属性'}
        </span>
        <button className="tag-editor-close" onClick={handleClose} title="关闭面板">
          <span className="codicon codicon-close" />
        </button>
      </div>

      <div className="tag-editor-body">
        {/* —— 封面预览 —— */}
        <div className="tag-editor-cover" onClick={handleCoverClick} title="点击更换封面">
          {loading ? (
            <div className="tag-editor-cover-loading">
              <span className="codicon codicon-loading codicon-modifier-spin" />
            </div>
          ) : coverUrl ? (
            <img src={coverUrl} alt="封面" className="tag-editor-cover-img" />
          ) : (
            <div className="tag-editor-cover-placeholder">
              <span className="codicon codicon-image" />
              <span className="tag-editor-cover-text">
                {isMulti ? '点击更换封面' : '无封面 · 点击添加'}
              </span>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="tag-editor-file-input"
          onChange={handleCoverChange}
        />

        {/* —— 元数据字段 —— */}
        <div className="tag-editor-field">
          <label className="tag-editor-label">标题</label>
          <input
            className="tag-editor-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isMulti ? '(多值)' : ''}
          />
        </div>
        <div className="tag-editor-field">
          <label className="tag-editor-label">歌手</label>
          <input
            className="tag-editor-input"
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder={isMulti ? '(多值)' : ''}
          />
        </div>
        <div className="tag-editor-field">
          <label className="tag-editor-label">专辑</label>
          <input
            className="tag-editor-input"
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
            placeholder={isMulti ? '(多值)' : ''}
          />
        </div>

        {/* —— 文件信息 (仅单选) —— */}
        {single && (
          <div className="tag-editor-info">
            <div className="tag-editor-info-row">
              <span className="tag-editor-info-label">格式</span>
              <span className="tag-editor-info-value">
                {single.filePath.split('.').pop()?.toUpperCase() ?? '-'}
              </span>
            </div>
            <div className="tag-editor-info-row">
              <span className="tag-editor-info-label">比特率</span>
              <span className="tag-editor-info-value">
                {single.bitrate >= 1000 ? `${(single.bitrate / 1000).toFixed(0)} kbps FLAC` : `${single.bitrate} kbps`}
              </span>
            </div>
            <div className="tag-editor-info-row">
              <span className="tag-editor-info-label">时长</span>
              <span className="tag-editor-info-value">
                {Math.floor(single.duration / 60)}:{Math.floor(single.duration % 60).toString().padStart(2, '0')}
              </span>
            </div>
            <div className="tag-editor-info-row">
              <span className="tag-editor-info-label">路径</span>
              <span className="tag-editor-info-value tag-editor-info-path" title={single.filePath}>
                {single.filePath}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* —— 保存 / 消息 —— */}
      <div className="tag-editor-footer">
        {saveMsg && (
          <div className={`tag-editor-msg ${saveMsg.type}`}>{saveMsg.text}</div>
        )}
        <button
          className="tag-editor-save"
          onClick={handleSave}
          disabled={saving || (!title && !artist && !album && newCoverBase64 === null)}
        >
          {saving ? (
            <>
              <span className="codicon codicon-loading codicon-modifier-spin" />
              保存中...
            </>
          ) : (
            <>
              <span className="codicon codicon-save" />
              保存
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
