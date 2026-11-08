import { create } from 'zustand';
import type { Playlist, Song } from '@/shared/types';
import { usePlayerStore } from './usePlayerStore';

interface PlaylistState {
  playlists: Playlist[];
  loading: boolean;
  selectedPlaylistId: number | null;
  /** 当前选中播放列表的歌曲 */
  playlistTracks: Song[];
  /** 是否处于「添加歌曲到播放列表」模式 */
  addToPlaylistMode: boolean;

  loadPlaylists: () => Promise<void>;
  createPlaylist: (name: string) => Promise<void>;
  deletePlaylist: (id: number) => Promise<void>;
  renamePlaylist: (id: number, name: string) => Promise<void>;
  selectPlaylist: (id: number | null) => Promise<void>;
  /** 把选中的播放列表歌曲作为播放队列 */
  playPlaylist: () => void;
  /** 批量添加歌曲到指定播放列表 */
  addSongsToPlaylist: (playlistId: number, songIds: number[]) => Promise<void>;
  /** 进入/退出添加歌曲模式 */
  enterAddMode: () => void;
  exitAddMode: () => void;
  /** 从播放列表移除歌曲 */
  removeSongFromPlaylist: (playlistId: number, songId: number) => Promise<void>;
  /** 导入 M3U 文件，创建播放列表并匹配库内歌曲 */
  importM3u: () => Promise<{ matched: number; total: number; name: string } | null>;
}

export const usePlaylistStore = create<PlaylistState>((set, get) => ({
  playlists: [],
  loading: false,
  selectedPlaylistId: null,
  playlistTracks: [],
  addToPlaylistMode: false,

  loadPlaylists: async () => {
    if (!window.api) return;
    set({ loading: true });
    try {
      const playlists = await window.api.getPlaylists();
      set({ playlists, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  createPlaylist: async (name) => {
    if (!window.api || !name.trim()) return;
    try {
      await window.api.createPlaylist(name.trim());
      await get().loadPlaylists();
    } catch (e) {
      console.error('[playlist] 创建失败:', e);
    }
  },

  deletePlaylist: async (id) => {
    if (!window.api) return;
    try {
      await window.api.deletePlaylist(id);
      if (get().selectedPlaylistId === id) {
        set({ selectedPlaylistId: null, playlistTracks: [] });
      }
      await get().loadPlaylists();
    } catch (e) {
      console.error('[playlist] 删除失败:', e);
    }
  },

  renamePlaylist: async (id, name) => {
    if (!window.api || !name.trim()) return;
    try {
      await window.api.renamePlaylist(id, name.trim());
      await get().loadPlaylists();
    } catch (e) {
      console.error('[playlist] 重命名失败:', e);
    }
  },

  selectPlaylist: async (id) => {
    if (id === null) {
      set({ selectedPlaylistId: null, playlistTracks: [] });
      return;
    }
    if (!window.api) return;
    set({ selectedPlaylistId: id });
    try {
      const songs = await window.api.getPlaylistSongs(id);
      set({ playlistTracks: songs });
    } catch (e) {
      console.error('[playlist] 加载歌曲失败:', e);
      set({ playlistTracks: [] });
    }
  },

  playPlaylist: () => {
    const tracks = get().playlistTracks;
    if (tracks.length > 0) {
      usePlayerStore.getState().playTrack(tracks[0], tracks);
    }
  },

  addSongsToPlaylist: async (playlistId, songIds) => {
    if (!window.api || songIds.length === 0) return;
    try {
      await window.api.addSongsToPlaylist(playlistId, songIds);
      // 如果加到当前选中的播放列表，刷新歌曲
      if (get().selectedPlaylistId === playlistId) {
        const songs = await window.api.getPlaylistSongs(playlistId);
        set({ playlistTracks: songs });
      }
      // 刷新播放列表列表（更新 songCount）
      await get().loadPlaylists();
    } catch (e) {
      console.error('[playlist] 批量添加歌曲失败:', e);
    }
  },

  enterAddMode: () => set({ addToPlaylistMode: true }),
  exitAddMode: () => set({ addToPlaylistMode: false }),

  removeSongFromPlaylist: async (playlistId, songId) => {
    if (!window.api) return;
    try {
      await window.api.removeSongFromPlaylist(playlistId, songId);
      if (get().selectedPlaylistId === playlistId) {
        const songs = await window.api.getPlaylistSongs(playlistId);
        set({ playlistTracks: songs });
      }
      await get().loadPlaylists();
    } catch (e) {
      console.error('[playlist] 移除歌曲失败:', e);
    }
  },

  importM3u: async () => {
    if (!window.api) return null;
    try {
      const result = await window.api.importM3u();
      if (!result) return null; // 用户取消选择
      await get().loadPlaylists();
      // 自动选中新导入的播放列表
      if (result.playlistId > 0) {
        await get().selectPlaylist(result.playlistId);
      }
      return { matched: result.matchedCount, total: result.totalEntries, name: result.playlistName };
    } catch (e) {
      console.error('[playlist] M3U 导入失败:', e);
      return null;
    }
  },
}));
