import { useEffect, useRef, useState } from 'react';
import { useAiStore } from '../stores/useAiStore';
import { usePlaylistStore } from '../stores/usePlaylistStore';
import { useAppStore } from '../stores/useAppStore';
import { parseTrackList } from '../utils/parseTrackList';
import { splitThinking } from '../utils/splitThinking';
import AiTrackCards from './AiTrackCards';

/** 关联了播放列表时展示的快捷指令 */
const QUICK_PROMPTS = [
  '分析这个播放列表的曲风、歌手、作曲人等特征',
  '根据我的口味推荐 10 首相似的歌曲',
  '推荐几首适合安静时听的歌',
  '这个列表里哪几首歌最有代表性？',
];

/** 轻量渲染：保留换行（CSS pre-wrap），**加粗** 转 strong */
function MessageContent({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <div className="ai-msg-text">
      {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}
    </div>
  );
}

/** active 时每秒刷新，返回自 since 起经过的秒数 */
function useElapsedSeconds(since: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
}

/** 等待首个响应时的分析动效：提示文字随等待时长推进，并显示已等待秒数 */
function AnalyzingIndicator({
  startedAt,
  playlistName,
  songCount,
}: {
  startedAt?: number;
  playlistName?: string;
  songCount: number;
}) {
  const secs = useElapsedSeconds(startedAt, true);
  const target = playlistName ? `播放列表「${playlistName}」的 ${songCount} 首歌曲` : '你的需求';
  const stage =
    secs < 2
      ? '正在连接 AI 服务'
      : secs < 15
        ? `正在分析${target}`
        : '仍在分析，推理模型可能需要更长时间';
  return (
    <div className="ai-analyzing">
      <span className="ai-analyzing-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="ai-analyzing-text">{stage}…</span>
      {secs > 0 && <span className="ai-analyzing-time">{secs}s</span>}
    </div>
  );
}

/** 推理过程：思考中展开并跟随滚动，正文开始后自动折叠（用户手动展开/折叠后以用户为准） */
function ThinkingBlock({
  text,
  thinking,
  startedAt,
  thinkingMs,
}: {
  text: string;
  thinking: boolean;
  startedAt?: number;
  thinkingMs?: number;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? thinking;
  const secs = useElapsedSeconds(startedAt, thinking);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (thinking && el) el.scrollTop = el.scrollHeight;
  }, [text, thinking, open]);

  const label = thinking
    ? `思考中 ${secs}s`
    : `已思考 ${Math.max(1, Math.round((thinkingMs ?? 0) / 1000))}s`;
  return (
    <div className={`ai-think${thinking ? ' active' : ''}`}>
      <button className="ai-think-header" onClick={() => setUserOpen(!open)}>
        <span
          className={`codicon ${thinking ? 'codicon-loading codicon-modifier-spin' : 'codicon-lightbulb'}`}
        />
        <span className="ai-think-label">{label}</span>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
      </button>
      {open && (
        <div className="ai-think-body" ref={bodyRef}>
          {text}
        </div>
      )}
    </div>
  );
}

/** AI 推荐面板 —— 顶部关联提示条 + 消息流 + 输入区 */
export default function AiChatPanel() {
  const config = useAiStore((s) => s.config);
  const messages = useAiStore((s) => s.messages);
  const streaming = useAiStore((s) => s.streaming);
  const streamError = useAiStore((s) => s.streamError);
  const input = useAiStore((s) => s.input);
  const setInput = useAiStore((s) => s.setInput);
  const send = useAiStore((s) => s.send);
  const stop = useAiStore((s) => s.stop);
  const clear = useAiStore((s) => s.clear);
  const loadConfig = useAiStore((s) => s.loadConfig);
  const linkedPlaylistId = useAiStore((s) => s.linkedPlaylistId);
  const linkedSongs = useAiStore((s) => s.linkedSongs);
  const setLinkedPlaylist = useAiStore((s) => s.setLinkedPlaylist);

  const playlists = usePlaylistStore((s) => s.playlists);
  const loadPlaylists = usePlaylistStore((s) => s.loadPlaylists);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  const scrollRef = useRef<HTMLDivElement>(null);

  // 首次挂载：加载配置 / 播放列表列表，恢复关联播放列表的歌曲快照
  useEffect(() => {
    loadConfig();
    loadPlaylists();
    const id = useAiStore.getState().linkedPlaylistId;
    if (id !== null) setLinkedPlaylist(id);
  }, []);

  // 消息更新时自动滚到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamError]);

  const linkedPlaylist = playlists.find((p) => p.id === linkedPlaylistId);
  /** apiKey 是唯一必填项（地址/模型有默认值） */
  const configured = !!config && config.apiKey.trim() !== '';

  const handleSend = () => {
    if (input.trim() && !streaming) send();
  };

  return (
    <div className="ai-panel">
      {/* 关联提示条 */}
      <div className="ai-linked-bar">
        <span className="codicon codicon-list-selection" />
        {linkedPlaylist ? (
          <>
            <span className="ai-linked-name">{linkedPlaylist.name}</span>
            <span className="ai-linked-count">{linkedSongs.length} 首</span>
          </>
        ) : (
          <span className="ai-linked-hint">未关联播放列表，可直接对话；到左侧边栏关联后可分析口味</span>
        )}
        {linkedPlaylist && (
          <button
            className="ai-linked-unlink"
            onClick={() => setLinkedPlaylist(null)}
            title="取消关联"
          >
            <span className="codicon codicon-close" />
          </button>
        )}
      </div>

      {/* 消息流 */}
      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && !configured && config !== null && (
          <div className="ai-guide-card">
            <span className="codicon codicon-hubot ai-guide-icon" />
            <div className="ai-guide-title">AI 服务未配置</div>
            <div className="ai-guide-desc">
              配置任意 OpenAI 兼容服务（OpenAI / DeepSeek / 通义千问 / Kimi / Ollama 等）后，
              即可基于你的播放列表分析口味并获得推荐。
            </div>
            <button
              className="playlist-btn playlist-btn-primary"
              onClick={() => setSettingsSection('ai')}
            >
              <span className="codicon codicon-settings-gear" />
              去配置
            </button>
          </div>
        )}
        {messages.length === 0 && configured && (
          <div className="ai-welcome">
            <span className="codicon codicon-sparkle ai-welcome-icon" />
            <div className="ai-welcome-title">你好，我是 AI 音乐助手</div>
            <div className="ai-welcome-desc">
              {linkedPlaylist
                ? `已关联播放列表「${linkedPlaylist.name}」，可以让我分析它的风格特征，或直接提出推荐要求。`
                : '可以关联左侧的播放列表让我分析你的口味，也可以直接描述你想要的音乐。'}
            </div>
            {linkedPlaylist && (
              <div className="ai-quick-chips">
                {QUICK_PROMPTS.map((q) => (
                  <button key={q} className="ai-chip" onClick={() => send(q)} disabled={streaming}>
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => {
          const isStreaming = streaming && i === messages.length - 1;
          if (m.role === 'user') {
            return (
              <div key={i} className="ai-msg user">
                <div className="ai-msg-bubble user">
                  <MessageContent text={m.content} />
                </div>
              </div>
            );
          }
          // 推理内容：reasoning_content 字段 + 正文内联的 <think>…</think>
          const inline = splitThinking(m.content);
          const thinkingText = [m.reasoning?.trim(), inline.thinking].filter(Boolean).join('\n\n');
          const answer = inline.answer;
          const stillThinking = isStreaming && !answer.trim();
          // 流式完成后才解析曲目清单（流式中文本不完整）
          const trackRefs = isStreaming ? [] : parseTrackList(answer);
          return (
            <div key={i} className="ai-msg assistant">
              <div className="ai-msg-bubble assistant">
                {thinkingText ? (
                  <ThinkingBlock
                    text={thinkingText}
                    thinking={stillThinking}
                    startedAt={m.startedAt}
                    thinkingMs={m.thinkingMs}
                  />
                ) : (
                  stillThinking && (
                    <AnalyzingIndicator
                      startedAt={m.startedAt}
                      playlistName={linkedPlaylist?.name}
                      songCount={linkedSongs.length}
                    />
                  )
                )}
                {answer && <MessageContent text={answer} />}
                {isStreaming && answer && <span className="ai-stream-cursor" />}
                {trackRefs.length > 0 && <AiTrackCards items={trackRefs} />}
              </div>
            </div>
          );
        })}
      </div>

      {/* 错误提示（用户主动停止不作为错误展示） */}
      {streamError && streamError !== '已停止生成' && (
        <div className="ai-error-bar">
          <span className="codicon codicon-error" />
          {streamError}
        </div>
      )}

      {/* 输入区 */}
      <div className="ai-input-area">
        {messages.length > 0 && !streaming && (
          <button className="ai-clear-btn" onClick={clear} title="清空对话">
            <span className="codicon codicon-clear-all" />
            清空对话
          </button>
        )}
        <div className="ai-input-row">
          <textarea
            className="ai-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={configured ? '输入消息，Enter 发送，Shift+Enter 换行...' : '请先配置 AI 服务...'}
            disabled={!configured}
            rows={3}
          />
          {streaming ? (
            <button className="ai-send-btn stop" onClick={() => stop()} title="停止生成">
              <span className="codicon codicon-debug-stop" />
            </button>
          ) : (
            <button
              className="ai-send-btn"
              onClick={handleSend}
              disabled={!configured || !input.trim()}
              title="发送"
            >
              <span className="codicon codicon-send" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
