import { useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useAppStore } from '../stores/useAppStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { useAiStore } from '../stores/useAiStore';
import logoUrl from '../assets/logo.png';

/**
 * 设置面板 —— 内容区（分区导航在左侧 Sidebar，与其他视图一致）。
 * 当前支持：外观主题、关于音枢。
 */
export default function SettingsPanel() {
  const section = useAppStore((s) => s.settingsSection);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  return (
    <div className="settings-panel">
      <div className="settings-content">
        {section === 'appearance' && (
          <div className="settings-section">
            <h3 className="settings-title">外观主题</h3>
            <p className="settings-desc">选择界面配色主题，立即生效并自动记住。</p>
            <div className="settings-theme-cards">
              <button
                className={`settings-theme-card ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => setTheme('dark')}
                title="深色主题（VS Code Dark+）"
              >
                <span className="settings-theme-preview dark">
                  <span className="bar title" />
                  <span className="bar side" />
                  <span className="bar main" />
                  <span className="bar player" />
                </span>
                <span className="settings-theme-name">深色主题</span>
                {theme === 'dark' && <span className="codicon codicon-check settings-theme-check" />}
              </button>
              <button
                className={`settings-theme-card ${theme === 'light' ? 'active' : ''}`}
                onClick={() => setTheme('light')}
                title="浅色主题"
              >
                <span className="settings-theme-preview light">
                  <span className="bar title" />
                  <span className="bar side" />
                  <span className="bar main" />
                  <span className="bar player" />
                </span>
                <span className="settings-theme-name">浅色主题</span>
                {theme === 'light' && <span className="codicon codicon-check settings-theme-check" />}
              </button>
            </div>
          </div>
        )}

        {section === 'audio' && (
          <div className="settings-section">
            <h3 className="settings-title">音频输出</h3>
            <p className="settings-desc">音频输出设置（开发中，敬请期待）。</p>
          </div>
        )}

        {section === 'library' && <LibrarySettingsSection />}

        {section === 'ai' && <AiSettingsSection />}

        {section === 'device' && (
          <div className="settings-section">
            <h3 className="settings-title">设备与同步</h3>
            <p className="settings-desc">设备与同步设置（开发中，敬请期待）。</p>
          </div>
        )}

        {section === 'about' && (
          <div className="settings-section">
            <div className="settings-about-logo">
              <img className="settings-about-logo-img" src={logoUrl} alt="AudioPivot 音枢" />
            </div>
            <h2 className="settings-about-name">AudioPivot 音枢</h2>
            <p className="settings-about-version">版本 0.1.0</p>
            <p className="settings-desc settings-about-desc">
              一款本地优先的音乐管理与 MTP 设备同步工具，为热爱音乐的您而设计。
            </p>
            <div className="settings-about-links">
              <span className="codicon codicon-github settings-about-link-icon" />
              <span>Electron + React + better-sqlite3</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** AI 服务配置：OpenAI 兼容接口（地址 / Key / 模型），保存 + 测试连接 */
function AiSettingsSection() {
  const config = useAiStore((s) => s.config);
  const loadConfig = useAiStore((s) => s.loadConfig);

  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 表单初值来自已保存配置
  useEffect(() => {
    if (config) {
      setBaseURL(config.baseURL);
      setApiKey(config.apiKey);
      setModel(config.model);
    }
  }, [config]);

  const handleSave = async () => {
    if (!window.api) return;
    setSaving(true);
    setResult(null);
    try {
      await window.api.ai.setConfig({ baseURL, apiKey, model });
      await loadConfig(); // 刷新侧边栏等处显示的服务状态
      setResult({ ok: true, message: '配置已保存' });
    } catch (e) {
      setResult({ ok: false, message: `保存失败：${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!window.api) return;
    setTesting(true);
    setResult(null);
    try {
      // 用表单当前值测试（无需先保存）
      const r = await window.api.ai.testConnection({ baseURL, apiKey, model });
      setResult(r);
    } catch (e) {
      setResult({ ok: false, message: `测试失败：${(e as Error).message}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-title">AI 服务</h3>
      <p className="settings-desc">
        配置任意 OpenAI 兼容服务（OpenAI / DeepSeek / 通义千问 / Kimi / 本地 Ollama 等），
        用于 AI 视图的口味分析与歌曲推荐。API Key 仅保存在本地，不会上传。
      </p>

      <div className="settings-field-label">API 地址</div>
      <input
        className="settings-ai-input"
        value={baseURL}
        onChange={(e) => setBaseURL(e.target.value)}
        placeholder="https://api.openai.com/v1"
        title="不含 /chat/completions，程序会自动拼接"
      />

      <div className="settings-field-label">API Key</div>
      <div className="settings-ai-key-row">
        <input
          className="settings-ai-input"
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-...（Ollama 等本地服务可随意填）"
        />
        <button
          className="playlist-btn settings-ai-key-toggle"
          onClick={() => setShowKey(!showKey)}
          title={showKey ? '隐藏' : '显示'}
        >
          <span className={`codicon ${showKey ? 'codicon-eye' : 'codicon-eye-closed'}`} />
        </button>
      </div>

      <div className="settings-field-label">模型名</div>
      <input
        className="settings-ai-input"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder="gpt-4o-mini / deepseek-chat / qwen-plus"
      />

      <div className="settings-ai-actions">
        <button
          className="playlist-btn playlist-btn-primary"
          onClick={handleSave}
          disabled={saving || !baseURL.trim() || !model.trim()}
        >
          <span className={`codicon codicon-save ${saving ? 'codicon-modifier-spin' : ''}`} />
          {saving ? '保存中...' : '保存配置'}
        </button>
        <button
          className="playlist-btn"
          onClick={handleTest}
          disabled={testing || !baseURL.trim() || !model.trim() || !apiKey.trim()}
          title="用表单当前值测试，无需先保存"
        >
          <span className={`codicon codicon-plug ${testing ? 'codicon-modifier-spin' : ''}`} />
          {testing ? '测试中...' : '测试连接'}
        </button>
      </div>

      {result && (
        <div className={`settings-ai-result ${result.ok ? 'ok' : 'error'}`}>
          <span className={`codicon ${result.ok ? 'codicon-pass' : 'codicon-error'}`} />
          {result.message}
        </div>
      )}
    </div>
  );
}

/** 音乐库源目录管理：选择/更改目录、重新扫描、扫描状态与汇总 */
function LibrarySettingsSection() {
  const libraryPath = useAppStore((s) => s.libraryPath);
  const setLibraryPath = useAppStore((s) => s.setLibraryPath);
  const tracks = useLibraryStore((s) => s.tracks);
  const scanning = useLibraryStore((s) => s.scanning);
  const scanProgress = useLibraryStore((s) => s.scanProgress);
  const lastScan = useLibraryStore((s) => s.lastScan);
  const scanAndLoad = useLibraryStore((s) => s.scanAndLoad);

  const selectFolder = async () => {
    // 浏览器预览时 window.api 不存在，用可选链避免报错
    const path = await window.api?.selectLibraryFolder();
    if (path) {
      setLibraryPath(path);
      scanAndLoad(path); // 选完目录立即扫描
    }
  };

  return (
    <div className="settings-section">
      <h3 className="settings-title">音乐库管理</h3>
      <p className="settings-desc">管理本地音乐库的源目录，扫描结果会增量合并入库。</p>

      <div className="settings-field-label">源目录</div>
      <div className="settings-lib-path-row">
        <div className="settings-lib-path" title={libraryPath ?? undefined}>
          <span className="codicon codicon-folder" />
          <span className="settings-lib-path-text">
            {libraryPath ?? '尚未选择音乐库目录'}
          </span>
        </div>
        <button
          className="playlist-btn playlist-btn-primary"
          onClick={selectFolder}
          disabled={scanning}
        >
          <span className="codicon codicon-folder-opened" />
          {libraryPath ? '更改目录' : '选择目录'}
        </button>
      </div>

      <div className="settings-field-label">扫描</div>
      <div className="settings-lib-scan-row">
        <button
          className="playlist-btn"
          onClick={() => libraryPath && scanAndLoad(libraryPath)}
          disabled={scanning || !libraryPath}
          title={libraryPath ? '重新扫描源目录（增量）' : '请先选择源目录'}
        >
          <span className={`codicon codicon-refresh ${scanning ? 'codicon-modifier-spin' : ''}`} />
          {scanning ? '扫描中...' : '重新扫描'}
        </button>
        {scanning && scanProgress && (
          <span className="settings-lib-scan-status">
            {scanProgress.phase === 'scanning' && `正在扫描文件 ${scanProgress.current}...`}
            {scanProgress.phase === 'parsing' &&
              `解析元数据 ${scanProgress.current}/${scanProgress.total}`}
            {scanProgress.phase === 'done' && '扫描完成'}
          </span>
        )}
      </div>

      {lastScan && !scanning && (
        <div className="settings-lib-summary">
          上次扫描：共 {lastScan.total} 首（新增 {lastScan.added}，更新 {lastScan.updated}，
          移除 {lastScan.removed}，未变化 {lastScan.unchanged}）
        </div>
      )}
      {!scanning && tracks.length > 0 && (
        <div className="settings-lib-summary">当前库内共 {tracks.length} 首歌曲。</div>
      )}
    </div>
  );
}
