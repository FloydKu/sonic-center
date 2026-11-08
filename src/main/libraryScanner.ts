import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import * as path from 'path';
import { getMusicMetadata } from './musicMetadata';

/** 支持扫描的音频扩展名 */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a']);

/** 目录扫描发现的文件（含 stat 信息，供增量判断） */
export interface DiscoveredFile {
  path: string;
  /** 修改时间（毫秒） */
  mtime: number;
  /** 文件大小（字节） */
  size: number;
}

/** 解析后的单首歌曲原始数据（含封面二进制，未序列化） */
export interface ParsedSong {
  filePath: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  composer?: string;
  duration: number;
  bitrate: number;
  format: string;
  fileSize: number;
  mtime: number;
  cover?: { mime: string; data: Buffer } | null;
}

/**
 * 递归遍历目录，收集所有支持的音频文件。
 * 使用 Node 内置 fs，无需额外依赖；如需更快的扫描可换用 fast-glob。
 */
export async function findAudioFiles(rootDir: string): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];
  await walk(rootDir, results);
  return results;
}

async function walk(dir: string, out: DiscoveredFile[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限或不存在，跳过
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      try {
        const stat = await fs.stat(full);
        out.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
      } catch {
        // 文件在读取间被删除等，跳过
      }
    }
  }
}

/**
 * 解析单个音频文件：用 music-metadata 读取 ID3/Vorbis 标签与嵌入式封面。
 * 失败会抛出异常，由调用方决定跳过或重试。
 */
export async function parseAudioFile(file: DiscoveredFile): Promise<ParsedSong> {
  const { parseFile } = await getMusicMetadata();
  const metadata = await parseFile(file.path);
  const common = metadata.common;
  const picture = common.picture?.[0];

  const ext = path.extname(file.path).slice(1).toLowerCase();

  return {
    filePath: file.path,
    title: common.title ?? path.basename(file.path, path.extname(file.path)),
    artist: common.artist ?? '未知歌手',
    album: common.album ?? '未知专辑',
    genre: common.genre?.[0],
    year: common.year,
    trackNo: common.track.no ?? undefined,
    composer: common.composer?.[0],
    duration: metadata.format.duration ?? 0,
    bitrate: metadata.format.bitrate ?? 0,
    format: metadata.format.container ?? ext,
    fileSize: file.size,
    mtime: file.mtime,
    cover: picture ? { mime: picture.format, data: Buffer.from(picture.data) } : null,
  };
}
