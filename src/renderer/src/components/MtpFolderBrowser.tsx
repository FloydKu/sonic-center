import { useState, useEffect, useCallback, Fragment } from 'react';
import type { MtpFileEntry } from '@/shared/types';

interface MtpFolderBrowserProps {
  /** MTP 设备标识 */
  deviceId: string;
  /** 初始路径 */
  initialPath: string;
  /** 浏览模式：folder 选择文件夹（默认）；file 选择文件（可配合 fileExtensions 过滤） */
  mode?: 'folder' | 'file';
  /** file 模式下仅显示匹配扩展名的文件（小写，不含点），如 ['m3u', 'm3u8']；不传则显示全部文件 */
  fileExtensions?: string[];
  /** 选择后回调（folder 模式返回目录路径，file 模式返回文件完整路径） */
  onSelect: (path: string) => void;
  /** 取消/关闭 */
  onClose: () => void;
}

/**
 * MTP 设备文件夹浏览弹窗 —— 通过 mtp:scan IPC 列出设备上的目录，
 * 允许用户逐级导航并选择目标文件夹或文件。
 */
export default function MtpFolderBrowser({
  deviceId,
  initialPath,
  mode = 'folder',
  fileExtensions,
  onSelect,
  onClose,
}: MtpFolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '\\');
  const [entries, setEntries] = useState<MtpFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** file 模式下当前选中的文件 */
  const [selectedFile, setSelectedFile] = useState<MtpFileEntry | null>(null);

  const scanFolder = useCallback(async (path: string, isFallback = false) => {
    setLoading(true);
    setError('');
    setSelectedFile(null);
    try {
      const result = window.api ? await window.api.mtp.scan(deviceId, path) : [];
      const visible = result.filter((e) => {
        if (mode === 'file') {
          // 文件模式：显示全部文件夹 + 匹配扩展名的文件
          if (e.isFolder) return true;
          if (!fileExtensions || fileExtensions.length === 0) return true;
          const dot = e.name.lastIndexOf('.');
          const ext = dot >= 0 ? e.name.slice(dot + 1).toLowerCase() : '';
          return fileExtensions.includes(ext);
        }
        // 文件夹模式：仅显示文件夹
        return e.isFolder;
      });
      // 文件夹排前，文件排后
      visible.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
      setEntries(visible);
    } catch (e) {
      // 首次扫描失败时自动回退到根目录
      if (!isFallback && path !== '\\') {
        setCurrentPath('\\');
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
      }
    } finally {
      setLoading(false);
    }
  }, [deviceId, mode, fileExtensions]);

  useEffect(() => {
    scanFolder(currentPath);
  }, [currentPath, scanFolder]);

  // Escape 关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 路径按 \ 分割为面包屑段 */
  const breadcrumbs = currentPath.split('\\').filter(Boolean);

  /** 返回上级目录 */
  const goUp = () => {
    if (breadcrumbs.length <= 1) {
      setCurrentPath('\\');
      return;
    }
    const parent = '\\' + breadcrumbs.slice(0, -1).join('\\');
    setCurrentPath(parent);
  };

  /** 点击面包屑跳转到指定层级 */
  const goToCrumb = (index: number) => {
    const path = '\\' + breadcrumbs.slice(0, index + 1).join('\\');
    setCurrentPath(path);
  };

  /** 进入子文件夹 */
  const enterFolder = (folder: MtpFileEntry) => {
    setCurrentPath(folder.path);
  };

  return (
    <div className="mtp-browser-overlay" onClick={onClose}>
      <div className="mtp-browser-modal" onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="mtp-browser-header">
          <span className={`codicon ${mode === 'file' ? 'codicon-file' : 'codicon-folder'}`} />
          <span className="mtp-browser-title">{mode === 'file' ? '选择设备文件' : '选择设备文件夹'}</span>
          <button className="mtp-browser-close" onClick={onClose} title="关闭">
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* 面包屑导航 */}
        <div className="mtp-browser-breadcrumb">
          <button
            className="mtp-browser-up"
            onClick={goUp}
            title="返回上级"
            disabled={currentPath === '\\' || breadcrumbs.length === 0}
          >
            <span className="codicon codicon-arrow-left" />
          </button>
          <div className="mtp-browser-crumbs">
            <span
              className={`mtp-browser-crumb ${currentPath === '\\' ? 'active' : ''}`}
              onClick={() => setCurrentPath('\\')}
            >
              <span className="codicon codicon-root-folder" />
              根目录
            </span>
            {breadcrumbs.map((seg, i) => (
              <Fragment key={i}>
                <span className="mtp-browser-crumb-sep">›</span>
                <span
                  className={`mtp-browser-crumb ${i === breadcrumbs.length - 1 ? 'active' : ''}`}
                  onClick={() => goToCrumb(i)}
                >
                  {seg}
                </span>
              </Fragment>
            ))}
          </div>
        </div>

        {/* 文件夹/文件列表 */}
        <div className="mtp-browser-body">
          {loading && (
            <div className="mtp-browser-loading">
              <span className="codicon codicon-sync codicon-modifier-spin" />
              正在扫描...
            </div>
          )}
          {error && <div className="mtp-browser-error">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="mtp-browser-empty">
              {mode === 'file' ? '此目录下没有可选择的文件' : '此目录下没有子文件夹'}
            </div>
          )}
          {!loading && !error && entries.map((e) => {
            const isSel = selectedFile?.path === e.path;
            return (
              <div
                key={e.path}
                className={`mtp-browser-item ${!e.isFolder && isSel ? 'selected' : ''}`}
                onClick={() => {
                  if (e.isFolder) enterFolder(e);
                  else if (mode === 'file') setSelectedFile(e);
                }}
                onDoubleClick={() => {
                  if (e.isFolder) enterFolder(e);
                }}
                title={e.path}
              >
                <span className={`codicon ${e.isFolder ? 'codicon-folder' : 'codicon-file'}`} />
                <span className="mtp-browser-item-name">{e.name}</span>
                {!e.isFolder && mode === 'file' && (
                  <span
                    className={`codicon ${isSel ? 'codicon-check' : 'codicon-circle-large-outline'} mtp-browser-item-check`}
                  />
                )}
                {e.isFolder && (
                  <span className="codicon codicon-chevron-right mtp-browser-item-arrow" />
                )}
              </div>
            );
          })}
        </div>

        {/* 当前路径 + 操作按钮 */}
        <div className="mtp-browser-footer">
          <div className="mtp-browser-current" title={selectedFile ? selectedFile.path : currentPath}>
            {mode === 'file' && selectedFile ? (
              <>已选文件：<code>{selectedFile.name}</code></>
            ) : (
              <>当前路径：<code>{currentPath}</code></>
            )}
          </div>
          <div className="mtp-browser-actions">
            <button className="mtp-btn mtp-btn-secondary" onClick={onClose}>
              取消
            </button>
            {mode === 'file' ? (
              <button
                className="mtp-btn mtp-btn-primary"
                onClick={() => selectedFile && onSelect(selectedFile.path)}
                disabled={loading || !selectedFile}
              >
                <span className="codicon codicon-check" />
                选择此文件
              </button>
            ) : (
              <button
                className="mtp-btn mtp-btn-primary"
                onClick={() => onSelect(currentPath)}
                disabled={loading}
              >
                <span className="codicon codicon-check" />
                选择此文件夹
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
