import { promises as fs } from 'fs';
import { findAudioFiles, parseAudioFile } from './libraryScanner';
import {
  getDb,
  upsertSong,
  setCover,
  clearCover,
  getExistingSongs,
  deleteSongByPath,
  getSongById,
  querySongs,
  getCover,
  getSongCount,
} from './db';
import { writeTags } from './tagEditor';
import type { ScanResult, ScanProgress, Song, GetSongsOptions, TagUpdate } from '../shared/types';

/** 确认数据库可用，否则抛出友好错误（让 IPC 层能把信息回传渲染进程） */
function ensureDb(): void {
  try {
    getDb();
  } catch (e) {
    throw new Error('数据库不可用：' + (e as Error).message);
  }
}

/**
 * 扫描音乐库目录并增量入库。
 * 增量策略：对比 DB 中已记录的 (file_path → mtime/size)，
 *   - mtime 与 size 均未变 → 跳过解析（unchanged）
 *   - 新文件或已变更 → 用 music-metadata 解析后 upsert，并写入封面
 *   - DB 中存在但磁盘已不存在 → 删除该行（removed，级联删除封面/播放列表关联）
 *
 * @param onProgress 进度回调（通常转发给渲染进程）
 */
export async function scanLibrary(
  rootDir: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanResult> {
  ensureDb();

  const result: ScanResult = {
    scanned: 0,
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    total: 0,
  };

  // 1. 递归发现音频文件
  onProgress?.({ phase: 'scanning', current: 0, total: 0 });
  const files = await findAudioFiles(rootDir);
  result.total = files.length;

  // 2. 读取现有记录用于增量比对
  const existing = getExistingSongs();

  // 3. 逐个处理：未变更跳过，否则解析+入库
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    result.scanned++;
    onProgress?.({
      phase: 'parsing',
      current: i + 1,
      total: files.length,
      currentFile: file.path,
    });

    const prev = existing.get(file.path);
    if (prev && prev.mtime === file.mtime && prev.size === file.size) {
      result.unchanged++;
      existing.delete(file.path);
      continue;
    }

    let parsed;
    try {
      parsed = await parseAudioFile(file);
    } catch (e) {
      console.warn('[scan] 解析失败，跳过:', file.path, e);
      existing.delete(file.path);
      continue;
    }

    const id = upsertSong(parsed);
    if (parsed.cover) {
      setCover(id, parsed.cover.mime, parsed.cover.data);
    } else {
      clearCover(id);
    }

    if (prev) result.updated++;
    else result.added++;
    existing.delete(file.path);
  }

  // 4. 剩余在 existing 中的 = 磁盘已删除的文件
  for (const filePath of existing.keys()) {
    deleteSongByPath(filePath);
    result.removed++;
  }

  result.total = getSongCount();
  onProgress?.({ phase: 'done', current: result.total, total: result.total });
  return result;
}

/**
 * 编辑 Tag：先写回文件，再重新解析该文件并刷新 DB（含封面），
 * 保证库内元数据与文件物理状态一致。返回更新后的 Song。
 */
export async function updateTag(filePath: string, update: TagUpdate): Promise<Song> {
  ensureDb();

  // 1. 写回文件
  await writeTags(filePath, update);

  // 2. 重新解析 + upsert
  const stat = await fs.stat(filePath);
  const parsed = await parseAudioFile({
    path: filePath,
    mtime: stat.mtimeMs,
    size: stat.size,
  });
  const id = upsertSong(parsed);
  if (parsed.cover) {
    setCover(id, parsed.cover.mime, parsed.cover.data);
  } else if (update.coverBase64 === null) {
    clearCover(id);
  }

  const song = getSongById(id);
  if (!song) throw new Error('更新标签后未能读取歌曲记录');
  return song;
}

/** 查询歌曲列表（同步读 DB） */
export function getSongs(opts?: GetSongsOptions): Song[] {
  ensureDb();
  return querySongs(opts);
}

/** 读取封面并转成 base64（便于渲染进程直接拼 data URL 显示） */
export function getSongCover(
  songId: number,
): { mime: string; base64: string } | null {
  ensureDb();
  const c = getCover(songId);
  return c ? { mime: c.mime, base64: c.data.toString('base64') } : null;
}
