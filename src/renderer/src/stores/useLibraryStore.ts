import { create } from 'zustand';
import type { Song, ScanProgress, ScanResult, GetSongsOptions } from '@/shared/types';

const PATH_KEY = 'sonic-center.libraryPath';

/** 音乐库排序字段 */
export type LibrarySortBy = NonNullable<GetSongsOptions['orderBy']>;

interface LibraryState {
  /** 库内全部歌曲（真实数据，来自 IPC） */
  tracks: Song[];
  loading: boolean;
  error: string | null;
  /** 正在扫描 */
  scanning: boolean;
  scanProgress: ScanProgress | null;
  /** 最近一次扫描汇总 */
  lastScan: ScanResult | null;
  /** 当前排序字段（名称/歌手/添加时间） */
  sortBy: LibrarySortBy;
  /** 排序方向 */
  sortDir: 'asc' | 'desc';
  /** 搜索关键词（歌名/歌手/专辑模糊匹配，空串表示不过滤） */
  search: string;

  /** 从 DB 加载歌曲列表（按当前排序+搜索词） */
  loadSongs: () => Promise<void>;
  /** 切换排序：点击相同字段翻转方向，不同字段切换并重设为升序 */
  setSort: (sortBy: LibrarySortBy) => void;
  /** 设置搜索词（300ms 防抖后自动重新加载） */
  setSearch: (search: string) => void;
  /** 扫描目录（增量），完成后自动刷新列表 */
  scanAndLoad: (dir: string) => Promise<void>;
}

let unsubProgress: (() => void) | null = null;
/** 搜索防抖计时器 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
/** loadSongs 请求序号：防抖/扫描并发时丢弃过期响应 */
let reqSeq = 0;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  loading: false,
  error: null,
  scanning: false,
  scanProgress: null,
  lastScan: null,
  sortBy: 'title',
  sortDir: 'asc',
  search: '',

  loadSongs: async () => {
    if (!window.api) return; // 浏览器预览降级
    const seq = ++reqSeq;
    set({ loading: true, error: null });
    try {
      const { sortBy, sortDir, search } = get();
      const tracks = await window.api.getSongs({
        orderBy: sortBy,
        orderDir: sortDir,
        search: search.trim() || undefined,
      });
      if (seq !== reqSeq) return; // 过期响应（已被新请求取代）
      set({ tracks, loading: false });
    } catch (e) {
      if (seq !== reqSeq) return;
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setSort: (sortBy) => {
    const cur = get();
    const next =
      cur.sortBy === sortBy
        ? { sortBy, sortDir: cur.sortDir === 'asc' ? ('desc' as const) : ('asc' as const) }
        : { sortBy, sortDir: 'asc' as const };
    set(next);
    get().loadSongs();
  },

  setSearch: (search) => {
    set({ search });
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void get().loadSongs();
    }, 300);
  },

  scanAndLoad: async (dir) => {
    if (!window.api) return;
    if (get().scanning) return;
    localStorage.setItem(PATH_KEY, dir);
    // 清理旧订阅，避免重复监听
    if (unsubProgress) unsubProgress();
    unsubProgress = window.api.onScanProgress((p) => set({ scanProgress: p }));
    set({ scanning: true, scanProgress: null, error: null });
    try {
      const result = await window.api.scanDirectory(dir);
      set({ scanning: false, lastScan: result });
      await get().loadSongs();
    } catch (e) {
      set({ scanning: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (unsubProgress) {
        unsubProgress();
        unsubProgress = null;
      }
    }
  },
}));

/** 读取上次记住的音乐库目录（持久化于 localStorage） */
export function getSavedLibraryPath(): string | null {
  try {
    return localStorage.getItem(PATH_KEY);
  } catch {
    return null;
  }
}
