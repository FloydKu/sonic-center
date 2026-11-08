import { useAppStore } from './stores/useAppStore';
import { useLibraryStore } from './stores/useLibraryStore';
import TitleBar from './components/TitleBar';
import ActivityBar from './components/ActivityBar';
import Sidebar from './components/Sidebar';
import MainView from './components/MainView';
import TagEditor from './components/TagEditor';
import StatusBar from './components/StatusBar';
// 引入即在模块加载时恢复上次主题（localStorage → html class）
import './stores/useSettingsStore';

/**
 * AudioPivot 音枢根组件 —— VS Code 风格布局
 * 顶部：自定义标题栏（拖拽 + 窗口控制）
 * 主体：活动栏 + 侧边栏 + 主视图（横向）
 * 下方：状态与播放控制栏
 */
export default function App() {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const tagEditorVisible = useAppStore((s) => s.tagEditorVisible);
  const hasSelection = useAppStore((s) => s.selectedTrackPaths.length > 0);
  const tracks = useLibraryStore((s) => s.tracks);

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <ActivityBar />
        {sidebarVisible && <Sidebar />}
        <MainView />
        {tagEditorVisible && hasSelection && <TagEditor tracks={tracks} />}
      </div>
      <StatusBar />
    </div>
  );
}
