import { create } from 'zustand';
import type { AiConfig, AiChatMessage } from '@/shared/types';
import type { Song } from '@/shared/types';
import { usePlaylistStore } from './usePlaylistStore';
import { splitThinking } from '../utils/splitThinking';

/** UI 展示的消息（system prompt 不入列，由 send 时动态构建） */
export interface AiUiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 推理模型的思考过程（reasoning_content 等字段） */
  reasoning?: string;
  /** 发出请求的时间戳（计算等待 / 思考时长） */
  startedAt?: number;
  /** 从发出请求到正文开始输出的耗时（思考时长） */
  thinkingMs?: number;
}

const LINKED_PLAYLIST_KEY = 'sonic-center.ai.linkedPlaylist';
/** 发送给 AI 的历史消息上限（不含 system），防止上下文过长 */
const MAX_HISTORY = 20;
/** system prompt 中播放列表歌曲清单上限 */
const MAX_PROMPT_SONGS = 150;

/** 恢复上次关联的播放列表 ID（无效值回退 null） */
function loadLinkedPlaylistId(): number | null {
  try {
    const saved = localStorage.getItem(LINKED_PLAYLIST_KEY);
    if (!saved) return null;
    const id = Number(saved);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 把关联播放列表的歌曲清单编进 system prompt */
function buildSystemPrompt(playlistName: string | null, songs: Song[]): string {
  const lines: string[] = [
    '你是 Sonic Center 音乐播放器内置的 AI 音乐推荐助手，擅长分析音乐风格并推荐歌曲。',
  ];
  if (playlistName && songs.length > 0) {
    const listed = songs.slice(0, MAX_PROMPT_SONGS);
    lines.push(
      `用户当前关联了播放列表「${playlistName}」（共 ${songs.length} 首），歌曲清单如下：`,
    );
    listed.forEach((s, i) => {
      // 逐字段拼接，缺失字段跳过；「未知歌手/未知专辑」也保留（反映真实标签状态）
      const parts = [s.artist, s.album, s.genre, s.year ? `${s.year}年` : '', s.composer]
        .filter((p) => p !== undefined && p !== null && p !== '')
        .map(String);
      lines.push(`${i + 1}. ${s.title}${parts.length ? ' - ' + parts.join(' - ') : ''}`);
    });
    if (songs.length > listed.length) {
      lines.push(`（清单过长，仅列出前 ${listed.length} 首）`);
    }
    lines.push(
      '请基于这份清单分析用户的音乐口味（曲风、歌手、作曲人、年代等特征），并据此回答问题或推荐歌曲。',
    );
  } else {
    lines.push('用户当前未关联播放列表，请直接根据用户的描述给出音乐分析与建议。');
  }
  lines.push(
    '推荐歌曲时可以自由推荐任意歌曲（不限于清单内），并简要说明推荐理由。',
    '当回复中包含歌曲推荐时，必须在回复最末尾另起一行输出标记「【曲目清单】」，随后每行一首、严格按「歌名 - 歌手」格式书写（不加序号、书名号、引号或推荐理由），最多 20 首。应用依赖该清单解析并提供试听播放，缺少标记将导致无法播放。',
    '请用中文回复，语气友好简洁。',
  );
  return lines.join('\n');
}

interface AiState {
  /** AI 服务配置（null = 尚未加载完成） */
  config: AiConfig | null;
  /** 关联的播放列表 ID（null = 不关联） */
  linkedPlaylistId: number | null;
  /** 关联播放列表的歌曲快照（发送时编入 system prompt） */
  linkedSongs: Song[];
  /** 对话消息（不含 system） */
  messages: AiUiMessage[];
  /** 是否正在流式接收回复 */
  streaming: boolean;
  /** 最近一次对话错误 */
  streamError: string | null;
  /** 输入框文本 */
  input: string;

  loadConfig: () => Promise<void>;
  /** 设置关联播放列表并拉取歌曲快照；null 取消关联 */
  setLinkedPlaylist: (id: number | null) => Promise<void>;
  /** 发送消息（text 省略时用 input）；流式期间忽略 */
  send: (text?: string) => Promise<void>;
  /** 停止当前生成 */
  stop: () => Promise<void>;
  /** 清空对话 */
  clear: () => void;
  setInput: (text: string) => void;
}

export const useAiStore = create<AiState>((set, get) => ({
  config: null,
  linkedPlaylistId: loadLinkedPlaylistId(),
  linkedSongs: [],
  messages: [],
  streaming: false,
  streamError: null,
  input: '',

  loadConfig: async () => {
    if (!window.api) return;
    try {
      const config = await window.api.ai.getConfig();
      set({ config });
    } catch (e) {
      console.error('[ai] 读取配置失败:', e);
    }
  },

  setLinkedPlaylist: async (id) => {
    set({ linkedPlaylistId: id });
    try {
      localStorage.setItem(LINKED_PLAYLIST_KEY, id === null ? '' : String(id));
    } catch {
      /* localStorage 不可用时静默忽略 */
    }
    if (id === null || !window.api) {
      set({ linkedSongs: [] });
      return;
    }
    try {
      const songs = await window.api.getPlaylistSongs(id);
      // 用户可能在等待期间又切了列表，仅当仍是当前关联时生效
      if (get().linkedPlaylistId === id) set({ linkedSongs: songs });
    } catch (e) {
      console.error('[ai] 加载播放列表歌曲失败:', e);
      if (get().linkedPlaylistId === id) set({ linkedSongs: [] });
    }
  },

  send: async (text) => {
    const content = (text ?? get().input).trim();
    if (!content || get().streaming) return;
    if (!window.api) return;

    // 追加用户消息 + 空的 AI 消息（流式 chunk 逐段填充）
    set((s) => ({
      messages: [
        ...s.messages,
        { role: 'user', content },
        { role: 'assistant', content: '', startedAt: Date.now() },
      ],
      input: '',
      streaming: true,
      streamError: null,
    }));

    // 历史截断：不含刚追加的空 assistant 消息
    const history = get().messages.slice(0, -1).slice(-MAX_HISTORY);
    const playlistName =
      usePlaylistStore.getState().playlists.find((p) => p.id === get().linkedPlaylistId)?.name ??
      null;
    const payload: AiChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(playlistName, get().linkedSongs) },
      // 历史中的推理内容不回传（DeepSeek 等服务要求不带上一轮思考过程，也节省上下文）；
      // 思考中被停止、没有正文的回复不回传（部分服务拒绝空 content）
      ...history
        .map((m) => ({
          role: m.role,
          content: m.role === 'assistant' ? splitThinking(m.content).answer : m.content,
        }))
        .filter((m) => m.content.trim() !== ''),
    ];

    try {
      await window.api.ai.chat(payload);
    } catch (e) {
      // invoke 层失败（主进程已兜底推送 done，这里防御性收尾）
      set({ streaming: false, streamError: (e as Error).message });
      return;
    }
    // 兜底：invoke 响应可能先于尾部 chunk/done 事件送达（实测存在乱序），
    // 成功路径不在此时复位 streaming，交由 done 事件处理；若 2 秒后仍未收到则强制复位
    setTimeout(() => {
      if (useAiStore.getState().streaming) setDone(null);
    }, 2000);
  },

  stop: async () => {
    if (!window.api) return;
    try {
      await window.api.ai.cancelChat();
    } catch (e) {
      console.error('[ai] 停止失败:', e);
    }
  },

  clear: () => set({ messages: [], streamError: null }),
  setInput: (text) => set({ input: text }),
}));

// 模块级订阅对话流事件：chunk / reasoning 逐段拼接到末尾 AI 消息，done 收尾。
// done 事件无条件处理（invoke 响应可能先于 done 送达，兜底复位可能已把 streaming 置 false）
if (window.api) {
  window.api.ai.onChatChunk((p) => {
    if (p.done) {
      setDone(p.error ?? null);
      return;
    }
    if (!p.chunk && !p.reasoning) return;
    const { streaming } = useAiStore.getState();
    if (!streaming) return;
    useAiStore.setState((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        const next: AiUiMessage = {
          ...last,
          content: last.content + (p.chunk ?? ''),
          reasoning: p.reasoning ? (last.reasoning ?? '') + p.reasoning : last.reasoning,
        };
        // 正文开始输出的时刻即思考结束
        if (next.thinkingMs === undefined && splitThinking(next.content).answer.trim()) {
          next.thinkingMs = Date.now() - (next.startedAt ?? Date.now());
        }
        messages[messages.length - 1] = next;
      }
      return { messages };
    });
  });
}

/** 流结束：复位 streaming，记录错误；末尾 AI 消息为空且出错时移除空消息 */
function setDone(error: string | null): void {
  useAiStore.setState((s) => {
    if (!s.streaming && !error) return {}; // 重复 done 事件时避免覆盖已有错误
    const messages = [...s.messages];
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      if (error && last.content === '' && !last.reasoning) {
        messages.pop();
      } else if (last.thinkingMs === undefined) {
        // 只有推理、没有正文（如被停止）时以结束时刻计思考时长
        messages[messages.length - 1] = {
          ...last,
          thinkingMs: Date.now() - (last.startedAt ?? Date.now()),
        };
      }
    }
    return { messages, streaming: false, streamError: error };
  });
}
