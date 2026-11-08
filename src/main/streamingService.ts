/**
 * 流媒体播放源解析服务。
 *
 * AI 推荐只输出「歌名 + 歌手」，真实可播地址由本服务按优先级解析：
 *   1. local   —— 本地音乐库命中 → 整曲播放（最佳）
 *   2. audius  —— Audius 公开 API 命中 → 免费整曲流（独立音乐曲库）
 *   3. preview —— iTunes Search API 命中 → 30 秒官方试听（多分区回退）
 *   4. none    —— 无可用音源 → UI 提供搜索跳转
 *
 * 设计原则：绝不信任 AI 生成的 URL（会幻觉、会失效），
 * 只信任应用自己从官方 API 换取的直链。
 */
import type { ResolvedStreamTrack, Song } from '../shared/types';
import { searchLocalSongs } from './db';

const HTTP_UA = 'SonicCenter/0.1 (Electron music player)';
/** 单个外部请求的超时（毫秒） */
const FETCH_TIMEOUT_MS = 6000;

// ----------------------------- 工具 -----------------------------

/** 归一化：去空白/标点/大小写，用于跨来源的宽松匹配 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s'"`‘’“”【】《》〈〉()（）\[\]·・。，、,．.!?！？:：;；\\/_\-–—~]/g, '');
}

/** 双向包含的宽松匹配（AI 输出的歌名常与平台曲名有细微出入） */
function looseContains(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': HTTP_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ----------------------------- 本地库 -----------------------------

/** 本地库匹配：LIKE 捞候选后做归一化宽松匹配 */
function pickLocal(title: string, artist: string): Song | null {
  let candidates: Song[];
  try {
    candidates = searchLocalSongs(title, artist || undefined);
  } catch {
    return null; // 数据库不可用（better-sqlite3 缺失等）
  }
  const hit = candidates.find(
    (s) => looseContains(s.title, title) && (!artist || looseContains(s.artist, artist)),
  );
  return hit ?? null;
}

// ----------------------------- Audius -----------------------------

/** 发现节点列表（单目录库：任一节点命中即整曲可播；节点可能被墙，逐个回退） */
const AUDIUS_NODES = [
  'discoveryprovider.audius.co',
  'discoveryprovider2.audius.co',
  'discoveryprovider3.audius.co',
];

interface AudiusTrack {
  id: string;
  title?: string;
  duration?: number;
  user?: { name?: string };
  artwork?: Record<string, string>;
}

/**
 * Audius 查找（免费整曲，官方公开 API，无需鉴权）。
 * 注意：节点正常响应但无匹配时直接返回 null——目录是全量共享的，
 * 换节点没有意义；只有网络失败才换下一个节点。
 */
async function audiusLookup(title: string, artist: string): Promise<ResolvedStreamTrack | null> {
  const query = [title, artist].filter(Boolean).join(' ');
  for (const node of AUDIUS_NODES) {
    try {
      const data = await fetchJson(
        `https://${node}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=5&app_name=SonicCenter`,
      );
      const tracks: AudiusTrack[] = Array.isArray(data?.data) ? data.data : [];
      const hit = tracks.find(
        (t) =>
          looseContains(t.title ?? '', title) &&
          (!artist || looseContains(t.user?.name ?? '', artist)),
      );
      if (!hit) return null;
      return {
        title: hit.title ?? title,
        artist: hit.user?.name ?? artist,
        kind: 'audius',
        streamUrl: `https://${node}/v1/tracks/${hit.id}/stream?app_name=SonicCenter`,
        duration: hit.duration,
        artworkUrl: hit.artwork?.['480x480'] ?? hit.artwork?.['150x150'],
      };
    } catch {
      /* 该节点不可达，换下一个 */
    }
  }
  return null;
}

// ----------------------------- iTunes 试听 -----------------------------

/**
 * 分区回退顺序：国际曲风在 US 命中率高，华语在 TW 命中率高
 * （iTunes 的中国购买商店无音乐内容，CN 分区不可用）。
 */
const ITUNES_COUNTRIES = ['US', 'TW', 'JP', 'SG'];

interface ItunesResult {
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
}

/**
 * iTunes Search API 查找 30 秒官方试听（免费、无需 Key）。
 * 各分区目录不同，未命中时需要逐个分区重试。
 */
async function itunesLookup(title: string, artist: string): Promise<ResolvedStreamTrack | null> {
  const term = encodeURIComponent([title, artist].filter(Boolean).join(' '));
  for (const country of ITUNES_COUNTRIES) {
    try {
      const data = await fetchJson(
        `https://itunes.apple.com/search?term=${term}&media=music&limit=8&country=${country}`,
      );
      const results: ItunesResult[] = Array.isArray(data?.results) ? data.results : [];
      const hit = results.find(
        (r) =>
          r.previewUrl &&
          looseContains(r.trackName ?? '', title) &&
          (!artist || looseContains(r.artistName ?? '', artist)),
      );
      if (!hit) continue;
      return {
        title: hit.trackName ?? title,
        artist: hit.artistName ?? artist,
        kind: 'preview',
        streamUrl: hit.previewUrl,
        duration: 30,
        artworkUrl: hit.artworkUrl100?.replace('100x100', '200x200'),
        trackViewUrl: hit.trackViewUrl,
      };
    } catch {
      /* 该分区请求失败，换下一个 */
    }
  }
  return null;
}

// ----------------------------- 对外入口 -----------------------------

/**
 * 解析单首推荐曲目的最佳播放源（本地 → Audius → iTunes 试听 → 无音源）。
 * 任一来源失败只影响该级降级，不会抛错。
 */
export async function resolveTrack(title: string, artist: string): Promise<ResolvedStreamTrack> {
  const cleanTitle = title.trim();
  const cleanArtist = artist.trim();

  const local = pickLocal(cleanTitle, cleanArtist);
  if (local) {
    return {
      title: local.title,
      artist: local.artist,
      kind: 'local',
      song: local,
      duration: local.duration,
    };
  }

  const audius = await audiusLookup(cleanTitle, cleanArtist);
  if (audius) return audius;

  const itunes = await itunesLookup(cleanTitle, cleanArtist);
  if (itunes) return itunes;

  return { title: cleanTitle, artist: cleanArtist, kind: 'none' };
}
