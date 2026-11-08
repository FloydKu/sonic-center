import { useAppStore } from '../stores/useAppStore';
import type { ViewId } from '../types';

interface NavItem {
  id: ViewId;
  icon: string;
  label: string;
}

const TOP_ITEMS: NavItem[] = [
  { id: 'library', icon: 'codicon-music', label: '音乐库' },
  { id: 'playlists', icon: 'codicon-list-ordered', label: '播放列表' },
  { id: 'ai', icon: 'codicon-sparkle', label: 'AI 推荐' },
  { id: 'devices', icon: 'codicon-sync', label: 'MTP 设备同步' },
];

const BOTTOM_ITEMS: NavItem[] = [
  { id: 'settings', icon: 'codicon-settings-gear', label: '设置' },
];

/** 活动栏 —— VS Code 风格最左侧的垂直图标导航 */
export default function ActivityBar() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const renderItem = (item: NavItem) => (
    <button
      key={item.id}
      className={`activity-bar-item ${activeView === item.id ? 'active' : ''}`}
      title={item.label}
      onClick={() => setActiveView(item.id)}
    >
      <span className={`codicon ${item.icon}`} />
    </button>
  );

  return (
    <nav className="activity-bar">
      <div className="activity-bar-top">{TOP_ITEMS.map(renderItem)}</div>
      <div className="activity-bar-bottom">{BOTTOM_ITEMS.map(renderItem)}</div>
    </nav>
  );
}
