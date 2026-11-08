/**
 * 自定义标题栏 —— 无边框窗口 (frame: false) 的拖拽区 + 窗口控制按钮
 * 主体区域 -webkit-app-region: drag 可拖动窗口，按钮区 no-drag。
 */
import logoUrl from '../assets/logo.png';

export default function TitleBar() {
  const controls = window.api?.window;

  return (
    <div className="title-bar">
      <div className="title-bar-drag">
        <img className="app-logo-img" src={logoUrl} alt="AudioPivot 音枢" />
        <span className="title-bar-text">AudioPivot 音枢</span>
      </div>
      <div className="title-bar-controls">
        <button
          className="title-bar-btn"
          onClick={() => controls?.minimize()}
          title="最小化"
        >
          <span className="codicon codicon-chrome-minimize" />
        </button>
        <button
          className="title-bar-btn"
          onClick={() => controls?.toggleMaximize()}
          title="最大化 / 还原"
        >
          <span className="codicon codicon-chrome-maximize" />
        </button>
        <button
          className="title-bar-btn close"
          onClick={() => controls?.close()}
          title="关闭"
        >
          <span className="codicon codicon-chrome-close" />
        </button>
      </div>
    </div>
  );
}
