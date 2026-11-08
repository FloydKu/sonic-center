import { create } from 'zustand';
import type { ViewId, Tab } from '../types';

interface AppState {
  /** 当前激活的活动视图 */
  activeView: ViewId;
  /** 设备视图的子页面：sync 同步面板 / manage 设备文件管理 */
  deviceSubview: 'sync' | 'manage';
  /** 设置视图当前展示的分区 */
  settingsSection: 'appearance' | 'audio' | 'library' | 'device' | 'ai' | 'about';
  /** 音乐库展示维度：songs 按歌曲 / albums 按专辑 */
  libraryViewMode: 'songs' | 'albums';
  /** 专辑模式下当前选中的专辑名（同名专辑可能多歌手，用 `album::artist` 复合键） */
  selectedAlbumKey: string | null;
  /** 侧边栏是否可见 */
  sidebarVisible: boolean;
  /** 音乐库根目录 */
  libraryPath: string | null;
  /** 当前选中的曲目文件路径（主选，最后点击的） */
  selectedTrackPath: string | null;
  /** 多选曲目文件路径列表（支持 Tag 编辑器批量编辑） */
  selectedTrackPaths: string[];
  /** Tag 编辑器面板是否可见 */
  tagEditorVisible: boolean;
  /** 主视图标签页 */
  tabs: Tab[];
  activeTabId: string;

  setActiveView: (view: ViewId) => void;
  /** 切换设备子视图（同步 / 管理设备文件） */
  setDeviceSubview: (sub: 'sync' | 'manage') => void;
  /** 切换设置分区（侧边栏设置项与主面板联动） */
  setSettingsSection: (section: 'appearance' | 'audio' | 'library' | 'device' | 'ai' | 'about') => void;
  /** 切换音乐库展示维度（按歌曲 / 按专辑） */
  setLibraryViewMode: (mode: 'songs' | 'albums') => void;
  /** 选中/取消选中专辑（复合键 `album::artist`） */
  selectAlbum: (key: string | null) => void;
  toggleSidebar: () => void;
  setLibraryPath: (path: string | null) => void;
  setSelectedTrack: (path: string | null) => void;
  /** 设置多选曲目列表，同时更新主选路径 */
  setSelectedTrackPaths: (paths: string[]) => void;
  /** 清除所有选中曲目 */
  clearSelection: () => void;
  /** 切换 Tag 编辑器面板可见性 */
  setTagEditorVisible: (visible: boolean) => void;
  openTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
}

const INITIAL_TABS: Tab[] = [
  { id: 'library', title: '音乐库', icon: 'codicon-music', closable: false },
];

export const useAppStore = create<AppState>((set) => ({
  activeView: 'library',
  deviceSubview: 'sync',
  settingsSection: 'appearance',
  libraryViewMode: 'songs',
  selectedAlbumKey: null,
  sidebarVisible: true,
  libraryPath: null,
  selectedTrackPath: null,
  selectedTrackPaths: [],
  tagEditorVisible: false,
  tabs: INITIAL_TABS,
  activeTabId: 'library',

  setActiveView: (view) =>
    set((state) => {
      // 再次点击已激活的视图时折叠侧边栏（VS Code 行为）
      if (view === state.activeView) {
        return { sidebarVisible: !state.sidebarVisible };
      }
      return { activeView: view, sidebarVisible: true };
    }),
  setDeviceSubview: (sub) => set({ deviceSubview: sub, activeView: 'devices', sidebarVisible: true }),
  setSettingsSection: (section) => set({ settingsSection: section, activeView: 'settings', sidebarVisible: true }),
  setLibraryViewMode: (mode) => set({ libraryViewMode: mode, activeView: 'library', sidebarVisible: true }),
  selectAlbum: (key) => set({ selectedAlbumKey: key, activeView: 'library' }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setLibraryPath: (path) => set({ libraryPath: path }),
  setSelectedTrack: (path) => set({ selectedTrackPath: path }),
  setSelectedTrackPaths: (paths) =>
    set({ selectedTrackPaths: paths, selectedTrackPath: paths[paths.length - 1] ?? null }),
  clearSelection: () => set({ selectedTrackPaths: [], selectedTrackPath: null }),
  setTagEditorVisible: (visible) => set({ tagEditorVisible: visible }),

  openTab: (tab) =>
    set((s) => {
      if (s.tabs.some((t) => t.id === tab.id)) return { activeTabId: tab.id };
      return { tabs: [...s.tabs, tab], activeTabId: tab.id };
    }),
  closeTab: (id) =>
    set((s) => {
      if (s.tabs.length <= 1) return {};
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? tabs[Math.max(0, idx - 1)].id : s.activeTabId;
      return { tabs, activeTabId };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
}));
