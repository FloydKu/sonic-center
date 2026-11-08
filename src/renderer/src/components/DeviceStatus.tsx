import { useDeviceStore } from '../stores/useDeviceStore';

/** 状态栏右侧设备连接状态指示器 */
export default function DeviceStatus() {
  const connected = useDeviceStore((s) => s.connected);
  const freeSpaceGB = useDeviceStore((s) => s.freeSpaceGB);
  const totalSpaceGB = useDeviceStore((s) => s.totalSpaceGB);
  const syncProgress = useDeviceStore((s) => s.syncProgress);

  const usedPct = connected
    ? Math.round(((totalSpaceGB - freeSpaceGB) / totalSpaceGB) * 100)
    : 0;

  return (
    <div className="device-status">
      {connected ? (
        <>
          <span className="device-dot connected" title="设备已连接" />
          <span className="codicon codicon-device-mobile device-icon" />
          <span className="device-name">播放器</span>
          <span className="device-sep">|</span>
          <span className="device-space">剩余 {freeSpaceGB} GB</span>
          <span className="device-bar" title={`已用 ${usedPct}%`}>
            <span className="device-bar-fill" style={{ width: `${usedPct}%` }} />
          </span>
          {syncProgress >= 0 && (
            <>
              <span className="device-sep">|</span>
              <span className="codicon codicon-sync codicon-modifier-spin device-sync-icon" />
              <span className="device-sync">同步中 {Math.round(syncProgress * 100)}%</span>
            </>
          )}
        </>
      ) : (
        <>
          <span className="device-dot disconnected" />
          <span className="device-name">未连接设备</span>
        </>
      )}
    </div>
  );
}
