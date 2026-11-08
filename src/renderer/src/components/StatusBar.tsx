import { useAppStore } from '../stores/useAppStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import PlayerControls from './PlayerControls';
import DeviceStatus from './DeviceStatus';

/**
 * 状态与播放控制栏
 * 左侧：音频播放控制器
 * 右侧：音乐库信息 + 设备连接状态
 */
export default function StatusBar() {
  const libraryPath = useAppStore((s) => s.libraryPath);
  const trackCount = useLibraryStore((s) => s.tracks.length);

  return (
    <footer className="status-bar">
      <div className="status-bar-player">
        <PlayerControls />
      </div>
      <div className="status-bar-right">
        {libraryPath && (
          <span className="status-bar-item" title={libraryPath}>
            <span className="codicon codicon-folder" />
            <span className="status-bar-item-text">{libraryPath}</span>
          </span>
        )}
        <span className="status-bar-item">
          <span className="codicon codicon-music" />
          <span>{trackCount} 首</span>
        </span>
        <DeviceStatus />
      </div>
    </footer>
  );
}
