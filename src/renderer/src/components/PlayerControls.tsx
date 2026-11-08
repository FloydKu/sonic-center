import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { usePlayerStore, useCurrentTrack } from '../stores/usePlayerStore';
import logoUrl from '../assets/logo.png';

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 底部播放控制器：上一首 / 播放暂停 / 下一首 / 进度条 / 音量 */
export default function PlayerControls() {
  const current = useCurrentTrack();
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const repeat = usePlayerStore((s) => s.repeat);
  const shuffle = usePlayerStore((s) => s.shuffle);

  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);

  // 拖拽进度条时使用本地状态，避免 timeupdate 干扰拖拽位置
  const [dragTime, setDragTime] = useState<number | null>(null);
  const displayTime = dragTime ?? currentTime;

  // ---- 当前列表队列气泡 ----
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLDivElement>(null);

  // 点击气泡外部关闭
  useEffect(() => {
    if (!queueOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (queueRef.current && !queueRef.current.contains(e.target as Node)) {
        setQueueOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [queueOpen]);

  const progress = duration > 0 ? (displayTime / duration) * 100 : 0;
  const effVolume = muted ? 0 : volume;
  const repeatLabel =
    repeat === 'off' ? '循环：关' : repeat === 'all' ? '列表循环' : '单曲循环';

  const progressStyle = { ['--p' as keyof CSSProperties]: `${progress}%` } as CSSProperties;
  const volumeStyle = { ['--p' as keyof CSSProperties]: `${effVolume * 100}%` } as CSSProperties;

  return (
    <div className="player-controls">
      <button
        className={`player-btn small ${shuffle ? 'on' : ''}`}
        title="随机播放"
        onClick={toggleShuffle}
      >
        <span className="codicon codicon-arrow-swap" />
      </button>
      <button className="player-btn" title="上一首" onClick={prev}>
        <span className="codicon codicon-debug-step-back" />
      </button>
      <button
        className="player-btn play"
        title={isPlaying ? '暂停' : '播放'}
        onClick={togglePlay}
      >
        <span className={`codicon ${isPlaying ? 'codicon-debug-pause' : 'codicon-play'}`} />
      </button>
      <button className="player-btn" title="下一首" onClick={next}>
        <span className="codicon codicon-debug-step-over" />
      </button>
      <button
        className={`player-btn small ${repeat !== 'off' ? 'on' : ''}`}
        title={repeatLabel}
        onClick={cycleRepeat}
      >
        <span className="codicon codicon-sync" />
        {repeat === 'one' && <span className="player-badge">1</span>}
      </button>

      <span className="player-time">{formatTime(displayTime)}</span>
      <input
        type="range"
        className="player-progress"
        style={progressStyle}
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(displayTime, duration || 0)}
        onChange={(e) => {
          setDragTime(Number(e.target.value));
        }}
        onMouseUp={(e) => {
          seek(Number(e.currentTarget.value));
          setDragTime(null);
        }}
        onTouchEnd={(e) => {
          seek(Number(e.currentTarget.value));
          setDragTime(null);
        }}
      />
      <span className="player-time">{formatTime(duration)}</span>

      <div className="player-now-playing" title={current?.filePath || current?.sourceUrl || ''}>
        {current ? (
          <>
            <img
              className="app-logo-img player-now-icon"
              src={current.artworkUrl ?? logoUrl}
              alt=""
            />
            <span className="player-now-title">{current.title}</span>
            <span className="player-now-sep">—</span>
            <span className="player-now-artist">{current.artist}</span>
            {current.remoteKind === 'preview' && (
              <span className="player-now-preview-tag">试听</span>
            )}
            {isBuffering && (
              <span className="player-now-preview-tag player-buffering-tag">
                <span className="codicon codicon-loading codicon-modifier-spin" />
                缓冲中
              </span>
            )}
          </>
        ) : (
          <span className="player-now-idle">未在播放</span>
        )}
      </div>

      {/* —— 当前列表队列气泡 —— */}
      <div className="player-queue-wrap" ref={queueRef}>
        <button
          className={`player-btn small ${queueOpen ? 'on' : ''}`}
          title="当前列表"
          onClick={() => setQueueOpen((v) => !v)}
        >
          <span className="codicon codicon-list-unordered" />
          {queue.length > 0 && <span className="player-badge">{queue.length}</span>}
        </button>
        {queueOpen && (
          <div className="player-queue-popover">
            <div className="player-queue-header">
              <span>当前播放队列</span>
              <span className="player-queue-count">{queue.length} 首</span>
            </div>
            <div className="player-queue-body">
              {queue.length === 0 && (
                <div className="player-queue-empty">队列为空</div>
              )}
              {queue.map((t, i) => (
                <div
                  key={`${t.id}-${i}`}
                  className={`player-queue-item ${i === currentIndex ? 'active' : ''}`}
                  onClick={() => playTrack(t, queue)}
                >
                  {i === currentIndex ? (
                    <span className="codicon codicon-play player-queue-playing" />
                  ) : (
                    <span className="player-queue-index">{i + 1}</span>
                  )}
                  <div className="player-queue-info">
                    <span className="player-queue-title">{t.title}</span>
                    <span className="player-queue-artist">{t.artist}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        className="player-btn small"
        title={muted || volume === 0 ? '取消静音' : '静音'}
        onClick={toggleMute}
      >
        <span
          className={`codicon ${muted || volume === 0 ? 'codicon-mute' : 'codicon-unmute'}`}
        />
      </button>
      <input
        type="range"
        className="player-volume"
        style={volumeStyle}
        min={0}
        max={1}
        step={0.01}
        value={effVolume}
        onChange={(e) => setVolume(Number(e.target.value))}
      />
    </div>
  );
}

