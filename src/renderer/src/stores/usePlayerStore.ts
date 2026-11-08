import { create } from 'zustand';
import type { Track } from '../types';

export type RepeatMode = 'off' | 'all' | 'one';

interface PlayerState {
  /** 播放队列 */
  queue: Track[];
  /** 当前曲目在队列中的索引，-1 表示空 */
  currentIndex: number;
  isPlaying: boolean;
  /** 远程流等待起播/缓冲中（播放条显示「缓冲中」反馈） */
  isBuffering: boolean;
  /** 当前播放时间（秒） */
  currentTime: number;
  /** 当前曲目总时长（秒） */
  duration: number;
  /** 音量 0~1 */
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;

  playTrack: (track: Track, queue?: Track[]) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (time: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  cycleRepeat: () => void;
  toggleShuffle: () => void;
  setCurrentTime: (time: number) => void;
}

// ============================================================================
//  模块级 HTML5 Audio 引擎
//  通过 local-media:// 自定义协议加载本地文件，事件驱动同步到 store
// ============================================================================

let audioEl: HTMLAudioElement | null = null;

/** 远程流连续失败计数（成功播放后清零），达到上限停止自动跳曲 */
let consecutiveRemoteErrors = 0;
/** 远程流自动跳曲上限，防止整条队列全部失效时无限循环 */
const MAX_REMOTE_ERRORS = 5;

function ensureAudio(): HTMLAudioElement {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.volume = 0.8;

  audioEl.addEventListener('timeupdate', () => {
    if (audioEl) {
      usePlayerStore.getState().setCurrentTime(audioEl.currentTime);
    }
  });
  audioEl.addEventListener('loadedmetadata', () => {
    if (audioEl?.duration && isFinite(audioEl.duration)) {
      usePlayerStore.setState({ duration: audioEl.duration });
    }
  });
  audioEl.addEventListener('durationchange', () => {
    if (audioEl?.duration && isFinite(audioEl.duration)) {
      usePlayerStore.setState({ duration: audioEl.duration });
    }
  });
  audioEl.addEventListener('ended', () => {
    const s = usePlayerStore.getState();
    if (s.repeat === 'one') {
      if (audioEl) {
        audioEl.currentTime = 0;
        audioEl.play().catch(() => {});
      }
    } else {
      s.next();
    }
  });
  audioEl.addEventListener('play', () => usePlayerStore.setState({ isPlaying: true }));
  audioEl.addEventListener('pause', () => usePlayerStore.setState({ isPlaying: false }));
  // 成功开始播放后清零失败计数，并结束缓冲态
  audioEl.addEventListener('playing', () => {
    consecutiveRemoteErrors = 0;
    usePlayerStore.setState({ isBuffering: false });
  });
  // 远程流数据未就绪（Audius 首字节可达数秒）：进入缓冲态，canplay 解除
  audioEl.addEventListener('waiting', () => usePlayerStore.setState({ isBuffering: true }));
  audioEl.addEventListener('canplay', () => usePlayerStore.setState({ isBuffering: false }));
  audioEl.addEventListener('error', () => {
    console.error('[player] 音频加载失败:', audioEl?.error);
    const s = usePlayerStore.getState();
    const cur = s.currentIndex >= 0 ? s.queue[s.currentIndex] : null;
    // 远程流（Audius/试听）可能失效：自动跳到下一首；连续失败达到上限则停止
    if (cur?.sourceUrl) {
      consecutiveRemoteErrors += 1;
      if (consecutiveRemoteErrors < MAX_REMOTE_ERRORS && s.queue.length > 1) {
        s.next();
      } else {
        usePlayerStore.setState({ isPlaying: false, isBuffering: false });
      }
    }
  });

  return audioEl;
}

/** 加载并播放：远程曲目（sourceUrl）直接走 https 流，本地曲目走 local-media:// 协议 */
function loadAndPlay(track: Track) {
  const audio = ensureAudio();
  // 远程流起播有网络延迟（Audius 首字节可达数秒），先进入缓冲态给出反馈
  usePlayerStore.setState({ isBuffering: !!track.sourceUrl });
  audio.src = track.sourceUrl ?? 'local-media://' + encodeURIComponent(track.filePath);
  audio.load();
  audio.play().catch((e) => {
    console.error('[player] 播放失败:', e);
    usePlayerStore.setState({ isBuffering: false });
  });
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  isBuffering: false,
  currentTime: 0,
  duration: 0,
  volume: 0.8,
  muted: false,
  repeat: 'off',
  shuffle: false,

  playTrack: (track, queue) => {
    const finalQueue = queue && queue.length ? queue : get().queue.length ? get().queue : [track];
    const idx = finalQueue.findIndex((t) => t.id === track.id);
    const index = idx >= 0 ? idx : 0;
    set({
      queue: finalQueue,
      currentIndex: index,
      isPlaying: true,
      currentTime: 0,
      duration: finalQueue[index]?.duration ?? track.duration,
    });
    loadAndPlay(finalQueue[index]);
  },

  togglePlay: () => {
    const audio = ensureAudio();
    if (!audio.src) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    // isPlaying 由 play/pause 事件同步
  },

  next: () => {
    const { queue, currentIndex, repeat, shuffle } = get();
    if (queue.length === 0) return;
    let nextIndex: number;
    if (shuffle && queue.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * queue.length);
      } while (nextIndex === currentIndex);
    } else {
      nextIndex = currentIndex + 1;
      if (nextIndex >= queue.length) {
        if (repeat === 'all') nextIndex = 0;
        else {
          set({ isPlaying: false, currentTime: 0 });
          ensureAudio().pause();
          return;
        }
      }
    }
    set({
      currentIndex: nextIndex,
      currentTime: 0,
      duration: queue[nextIndex].duration,
      isPlaying: true,
    });
    loadAndPlay(queue[nextIndex]);
  },

  prev: () => {
    const { queue, currentIndex, currentTime } = get();
    if (queue.length === 0) return;
    // 播放超过 3 秒则回到当前曲目开头
    if (currentTime > 3) {
      const audio = ensureAudio();
      audio.currentTime = 0;
      set({ currentTime: 0 });
      return;
    }
    const prevIndex = currentIndex <= 0 ? queue.length - 1 : currentIndex - 1;
    set({
      currentIndex: prevIndex,
      currentTime: 0,
      duration: queue[prevIndex].duration,
      isPlaying: true,
    });
    loadAndPlay(queue[prevIndex]);
  },

  seek: (time) => {
    const audio = ensureAudio();
    const wasPlaying = !audio.paused;
    audio.currentTime = time;
    set({ currentTime: time });
    // seek 后确保继续播放（某些情况下 seek 可能触发 waiting/pause）
    if (wasPlaying) {
      audio.play().catch(() => {});
    }
  },
  setVolume: (v) => {
    ensureAudio().volume = v;
    set({ volume: v, muted: v === 0 });
  },
  toggleMute: () => {
    const audio = ensureAudio();
    set((s) => {
      const muted = !s.muted;
      audio.volume = muted ? 0 : s.volume;
      return { muted };
    });
  },
  cycleRepeat: () =>
    set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
  setCurrentTime: (time) => set({ currentTime: time }),
}));

/** 当前正在播放的曲目 */
export const useCurrentTrack = (): Track | null =>
  usePlayerStore((s) => (s.currentIndex >= 0 ? (s.queue[s.currentIndex] ?? null) : null));
