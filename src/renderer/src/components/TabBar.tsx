import { useAppStore } from '../stores/useAppStore';
import { usePlaylistStore } from '../stores/usePlaylistStore';
import { useDeviceStore } from '../stores/useDeviceStore';

/** 标签页栏 —— VS Code 风格的主视图顶部 Tab */
export default function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);

  const activeView = useAppStore((s) => s.activeView);
  const selectedPlaylistId = usePlaylistStore((s) => s.selectedPlaylistId);
  const playlists = usePlaylistStore((s) => s.playlists);
  const deviceName = useDeviceStore((s) => s.deviceName);
  const connected = useDeviceStore((s) => s.connected);

  // 动态计算第一个 Tab 的标题和图标
  const selectedPlaylist = playlists.find((p) => p.id === selectedPlaylistId);
  let dynamicTitle = '音乐库';
  let dynamicIcon = 'codicon-music';
  if (activeView === 'playlists' && selectedPlaylist) {
    dynamicTitle = selectedPlaylist.name;
    dynamicIcon = 'codicon-list-selection';
  } else if (activeView === 'ai') {
    dynamicTitle = 'AI 推荐';
    dynamicIcon = 'codicon-sparkle';
  } else if (activeView === 'devices') {
    dynamicTitle = connected && deviceName ? deviceName : 'MTP 设备';
    dynamicIcon = 'codicon-device-mobile';
  }

  return (
    <div className="tab-bar">
      <div className="tab-bar-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.id === 'library' ? dynamicTitle : tab.title}
          >
            {tab.id === 'library' ? (
              <>
                <span className={`codicon ${dynamicIcon} tab-icon`} />
                <span className="tab-title">{dynamicTitle}</span>
              </>
            ) : (
              <>
                {tab.icon && <span className={`codicon ${tab.icon} tab-icon`} />}
                <span className="tab-title">{tab.title}</span>
              </>
            )}
            {tab.closable && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                title="关闭"
              >
                <span className="codicon codicon-close" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="tab-bar-actions">
        <button className="tab-bar-action" title="更多操作">
          <span className="codicon codicon-ellipsis" />
        </button>
      </div>
    </div>
  );
}
