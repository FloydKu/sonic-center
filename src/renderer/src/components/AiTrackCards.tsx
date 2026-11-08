import { useEffect, useMemo, useState } from 'react';
import type { ResolvedStreamTrack } from '@/shared/types';
import type { Track } from '../types';
import { usePlayerStore } from '../stores/usePlayerStore';
import type { ParsedTrackRef } from '../utils/parseTrackList';

/** 各播放源的展示徽标 */
const KIND_BADGES: Record<string, { label: string; icon: string; cls: string }> = {
  local: { label: '本地 · 全曲', icon: 'codicon-device-desktop', cls: 'local' },
  audius: { label: 'Audius · 全曲', icon: 'codicon-radio-tower', cls: 'audius' },
  preview: { label: '试听 30s', icon: 'codicon-play-circle', cls: 'preview' },
  none: { label: '无音源', icon: 'codicon-link-external', cls: 'none' },
};

/** 无音源时的搜索跳转（网易云音乐搜索） */
function neteaseSearchUrl(title: string, artist: string): string {
  return `https://music.163.com/#/search/m/?s=${encodeURIComponent(`${title} ${artist}`)}&type=1`;
}

/**
 * 把解析结果转成播放器队列曲目。
 * 远程曲目用负数合成 id（同一批次内递减），避免与本地库正数 id 冲突。
 */
function toTrack(r: ResolvedStreamTrack, id: number): Track {
  if (r.kind === 'local' && r.song) {
    return { ...r.song };
  }
  return {
    id,
    title: r.title,
    artist: r.artist,
    album: '',
    duration: r.kind === 'preview' ? 30 : (r.duration ?? 0),
    bitrate: 0,
    filePath: '',
    sourceUrl: r.streamUrl,
    remoteKind: r.kind === 'audius' ? 'audius' : 'preview',
    artworkUrl: r.artworkUrl,
  };
}

/**
 * AI 推荐曲目卡：挂在助手气泡尾部，逐首解析播放源
 * （本地全曲 → Audius 全曲 → iTunes 试听 → 无音源跳转），
 * 支持单曲播放与整单播放，队列 = 该清单内全部可播放曲目。
 */
export default function AiTrackCards({ items }: { items: ParsedTrackRef[] }) {
  const playTrack = usePlayerStore((s) => s.playTrack);
  /** 与 items 一一对应；null = 解析中 */
  const [resolved, setResolved] = useState<(ResolvedStreamTrack | null)[]>(() =>
    items.map(() => null),
  );

  // 挂载后并行解析全部曲目（结果逐个回填，实现渐进式徽标）；
  // 远程流解析成功后立即预热（预建连接 + 预缓冲），降低点播等待
  useEffect(() => {
    let cancelled = false;
    const warmers: HTMLAudioElement[] = [];
    items.forEach((it, i) => {
      window.api?.stream
        .resolveTrack(it.title, it.artist)
        .then((r) => {
          if (r.streamUrl) {
            const a = new Audio();
            a.preload = 'auto';
            a.src = r.streamUrl;
            warmers.push(a);
          }
          if (!cancelled) {
            setResolved((prev) => {
              const next = [...prev];
              next[i] = r;
              return next;
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResolved((prev) => {
              const next = [...prev];
              next[i] = { title: it.title, artist: it.artist, kind: 'none' };
              return next;
            });
          }
        });
    });
    return () => {
      cancelled = true;
      warmers.forEach((a) => {
        a.removeAttribute('src');
        a.load();
      });
    };
  }, [items]);

  /** 可播放条目（保持推荐顺序），itemIndex 记录在清单中的原始位置 */
  const playable = useMemo(() => {
    const out: { track: Track; itemIndex: number }[] = [];
    let seq = 0;
    const base = -Date.now();
    resolved.forEach((r, i) => {
      if (r && r.kind !== 'none') {
        out.push({ track: toTrack(r, base - seq++), itemIndex: i });
      }
    });
    return out;
  }, [resolved]);

  const playableCount = playable.length;

  const playAll = () => {
    if (playable.length === 0) return;
    playTrack(playable[0].track, playable.map((p) => p.track));
  };

  const playOne = (itemIndex: number) => {
    const entry = playable.find((p) => p.itemIndex === itemIndex);
    if (!entry) return;
    playTrack(entry.track, playable.map((p) => p.track));
  };

  const openExternal = (url?: string) => {
    if (url) window.api?.openExternal(url).catch(() => {});
  };

  return (
    <div className="ai-tracks-card">
      <div className="ai-tracks-header">
        <span className="ai-tracks-title">
          <span className="codicon codicon-list-unordered" />
          识别到 {items.length} 首曲目
        </span>
        <span className="ai-tracks-progress">
          {playableCount > 0 ? `${playableCount} 首可播放` : '解析播放源中...'}
        </span>
        <button
          className="playlist-btn playlist-btn-primary ai-tracks-playall"
          onClick={playAll}
          disabled={playableCount === 0}
          title="播放清单内全部可播放曲目"
        >
          <span className="codicon codicon-play" />
          播放全部
        </button>
      </div>
      <div className="ai-tracks-body">
        {items.map((it, i) => {
          const r = resolved[i];
          const badge = r ? KIND_BADGES[r.kind] : null;
          return (
            <div key={`${it.title}-${i}`} className="ai-track-row">
              <button
                className="ai-track-play"
                onClick={() => playOne(i)}
                disabled={!r || r.kind === 'none'}
                title={r?.kind === 'preview' ? '播放 30 秒试听' : '播放全曲'}
              >
                <span className="codicon codicon-play" />
              </button>
              <span className="ai-track-name" title={it.title}>
                {it.title}
              </span>
              <span className="ai-track-artist" title={it.artist}>
                {it.artist}
              </span>
              {badge ? (
                <span className={`ai-track-badge ${badge.cls}`}>
                  <span className={`codicon ${badge.icon}`} />
                  {badge.label}
                </span>
              ) : (
                <span className="ai-track-badge loading">
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                  解析中
                </span>
              )}
              {r?.kind === 'preview' && r.trackViewUrl && (
                <button
                  className="ai-track-link"
                  onClick={() => openExternal(r.trackViewUrl)}
                  title="在 Apple Music 中查看完整歌曲"
                >
                  <span className="codicon codicon-link-external" />
                </button>
              )}
              {r?.kind === 'none' && (
                <button
                  className="ai-track-link"
                  onClick={() => openExternal(neteaseSearchUrl(it.title, it.artist))}
                  title="去网易云音乐搜索完整歌曲"
                >
                  <span className="codicon codicon-search" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="ai-tracks-footer">
        全曲来源：本地音乐库与 Audius；试听片段来自 Apple iTunes Search
        API，完整收听请前往相应平台。
      </div>
    </div>
  );
}
