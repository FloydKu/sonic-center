import * as path from 'path';
import { app } from 'electron';
import type { ParsedSong } from './libraryScanner';
import type { Song, GetSongsOptions, Playlist } from '../shared/types';

// better-sqlite3 是原生 C++ 模块，在缺少 Visual Studio 构建工具或 Node ABI 不匹配时
// 可能无法编译/加载。这里用「类型仅引入 + 运行时延迟 require + try/catch」的方式，
// 使应用即使没有可用的 SQLite 也能正常启动 UI，数据库相关功能会在调用时才报错。
type BetterSqlite3 = typeof import('better-sqlite3');
type SqlDatabase = InstanceType<BetterSqlite3>;

let DatabaseCtor: BetterSqlite3 | null = null;
try {
  DatabaseCtor = require('better-sqlite3');
} catch (e) {
  console.warn('[db] better-sqlite3 不可用，数据库功能已禁用：', (e as Error).message);
}

let db: SqlDatabase | null = null;

const SONG_COLUMNS = `
  s.id, s.file_path, s.title, s.artist, s.album, s.genre, s.year, s.track_no,
  s.composer, s.duration_sec, s.bitrate, s.format, s.file_size, s.mtime, s.has_cover,
  s.created_at, s.updated_at
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT,
    artist TEXT,
    album TEXT,
    genre TEXT,
    year INTEGER,
    track_no INTEGER,
    composer TEXT,
    duration_sec REAL,
    bitrate INTEGER,
    format TEXT,
    file_size INTEGER,
    mtime INTEGER,
    has_cover INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
  CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album);
  CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title);

  CREATE TABLE IF NOT EXISTS covers (
    song_id INTEGER PRIMARY KEY,
    mime TEXT,
    data BLOB,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlist_songs (
    playlist_id INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );
`;

/** 初始化 SQLite 数据库并建表；若 better-sqlite3 不可用则安全跳过 */
export function initDatabase(): SqlDatabase | null {
  if (!DatabaseCtor) {
    console.warn('[db] 跳过数据库初始化（better-sqlite3 未安装或未编译）');
    return null;
  }
  try {
    const dbPath = path.join(app.getPath('userData'), 'library.db');
    const database = new DatabaseCtor(dbPath);
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.exec(SCHEMA);
    // 旧库迁移：songs 表补充 composer 列（CREATE TABLE IF NOT EXISTS 不会更新已有表）
    const columns = database.pragma('table_info(songs)') as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'composer')) {
      database.exec('ALTER TABLE songs ADD COLUMN composer TEXT');
      console.log('[db] 已迁移：songs 表新增 composer 列');
    }
    db = database;
    console.log('[db] 数据库已就绪:', dbPath);
    return db;
  } catch (e) {
    console.error('[db] 数据库初始化失败：', e);
    db = null;
    return null;
  }
}

/** 获取数据库实例；若不可用会抛出明确错误 */
export function getDb(): SqlDatabase {
  if (!db) throw new Error('数据库尚未初始化（better-sqlite3 可能未安装/未编译）');
  return db;
}

/** 关闭数据库连接 */
export function closeDatabase(): void {
  db?.close();
  db = null;
}

// ----------------------------- 歌曲 -----------------------------

interface SongRow {
  id: number;
  file_path: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  track_no: number | null;
  composer: string | null;
  duration_sec: number | null;
  bitrate: number | null;
  format: string | null;
  file_size: number | null;
  mtime: number | null;
  has_cover: number | null;
  created_at: string | null;
  updated_at: string | null;
}

function rowToSong(r: SongRow): Song {
  return {
    id: r.id,
    filePath: r.file_path,
    title: r.title ?? '',
    artist: r.artist ?? '未知歌手',
    album: r.album ?? '未知专辑',
    genre: r.genre ?? undefined,
    year: r.year ?? undefined,
    trackNo: r.track_no ?? undefined,
    composer: r.composer ?? undefined,
    duration: r.duration_sec ?? 0,
    bitrate: r.bitrate ?? 0,
    format: r.format ?? '',
    fileSize: r.file_size ?? 0,
    mtime: r.mtime ?? 0,
    hasCover: !!r.has_cover,
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  };
}

/** 新增或更新一首歌曲（按 file_path 去重），返回 song id */
export function upsertSong(s: ParsedSong): number {
  const d = getDb();
  const row = d.prepare(`
    INSERT INTO songs (file_path, title, artist, album, genre, year, track_no, composer,
      duration_sec, bitrate, format, file_size, mtime, has_cover, updated_at)
    VALUES (@filePath, @title, @artist, @album, @genre, @year, @trackNo, @composer,
      @duration, @bitrate, @format, @fileSize, @mtime, @hasCover, datetime('now'))
    ON CONFLICT(file_path) DO UPDATE SET
      title=excluded.title, artist=excluded.artist, album=excluded.album, genre=excluded.genre,
      year=excluded.year, track_no=excluded.track_no, composer=excluded.composer,
      duration_sec=excluded.duration_sec, bitrate=excluded.bitrate, format=excluded.format,
      file_size=excluded.file_size, mtime=excluded.mtime, has_cover=excluded.has_cover,
      updated_at=datetime('now')
    RETURNING id
  `).get({
    filePath: s.filePath,
    title: s.title,
    artist: s.artist,
    album: s.album,
    genre: s.genre ?? null,
    year: s.year ?? null,
    trackNo: s.trackNo ?? null,
    composer: s.composer ?? null,
    duration: s.duration,
    bitrate: s.bitrate,
    format: s.format,
    fileSize: s.fileSize,
    mtime: s.mtime,
    hasCover: s.cover ? 1 : 0,
  }) as { id: number } | undefined;
  return row?.id ?? 0;
}

/** 读取全部歌曲的「路径 → {id, mtime, size}」映射，用于增量扫描比对 */
export function getExistingSongs(): Map<string, { id: number; mtime: number; size: number }> {
  const rows = getDb().prepare(
    'SELECT id, file_path, mtime, file_size FROM songs',
  ).all() as { id: number; file_path: string; mtime: number; file_size: number }[];
  const map = new Map<string, { id: number; mtime: number; size: number }>();
  for (const r of rows) map.set(r.file_path, { id: r.id, mtime: r.mtime, size: r.file_size });
  return map;
}

export function deleteSongByPath(filePath: string): void {
  getDb().prepare('DELETE FROM songs WHERE file_path = ?').run(filePath);
}

export function getSongById(id: number): Song | null {
  const r = getDb().prepare(`SELECT ${SONG_COLUMNS} FROM songs s WHERE s.id = ?`).get(id) as
    | SongRow
    | undefined;
  return r ? rowToSong(r) : null;
}

/** 查询歌曲列表，支持搜索 / 分页 / 排序 / 播放列表过滤 */
export function querySongs(opts: GetSongsOptions = {}): Song[] {
  const {
    limit,
    offset = 0,
    search,
    playlistId,
    orderBy = 'title',
    orderDir = 'asc',
  } = opts;

  const orderCol = (
    { title: 's.title', artist: 's.artist', album: 's.album', added: 's.created_at' } as const
  )[orderBy] ?? 's.title';
  const dir = orderDir === 'desc' ? 'DESC' : 'ASC';

  let sql = `SELECT ${SONG_COLUMNS} FROM songs s`;
  const params: unknown[] = [];
  const where: string[] = [];

  if (playlistId !== undefined) {
    sql += ' JOIN playlist_songs ps ON ps.song_id = s.id';
    where.push('ps.playlist_id = ?');
    params.push(playlistId);
  }
  if (search) {
    where.push('(s.title LIKE ? OR s.artist LIKE ? OR s.album LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');

  // 未指定 limit 时返回全部（SQLite 中 LIMIT -1 表示不限制，OFFSET 仍需搭配 LIMIT 使用）
  sql += ` ORDER BY ${orderCol} ${dir} NULLS LAST LIMIT ? OFFSET ?`;
  params.push(limit ?? -1, offset);

  const rows = getDb().prepare(sql).all(...params) as SongRow[];
  return rows.map(rowToSong);
}

export function getSongCount(): number {
  const r = getDb().prepare('SELECT COUNT(*) AS c FROM songs').get() as { c: number };
  return r.c;
}

/**
 * 按「标题（必填）+ 歌手（可选）」LIKE 模糊查找本地歌曲，
 * 供流媒体播放源分流使用（候选集很小，精确归一化匹配由调用方完成）。
 */
export function searchLocalSongs(title: string, artist?: string): Song[] {
  const params: unknown[] = [`%${title}%`];
  let sql = `SELECT ${SONG_COLUMNS} FROM songs s WHERE s.title LIKE ?`;
  if (artist) {
    sql += ' AND s.artist LIKE ?';
    params.push(`%${artist}%`);
  }
  sql += ' LIMIT 20';
  const rows = getDb().prepare(sql).all(...params) as SongRow[];
  return rows.map(rowToSong);
}

// ----------------------------- 封面 -----------------------------

export function setCover(songId: number, mime: string, data: Buffer): void {
  getDb()
    .prepare(
      `INSERT INTO covers (song_id, mime, data) VALUES (?, ?, ?)
       ON CONFLICT(song_id) DO UPDATE SET mime=excluded.mime, data=excluded.data`,
    )
    .run(songId, mime, data);
}

export function clearCover(songId: number): void {
  getDb().prepare('DELETE FROM covers WHERE song_id = ?').run(songId);
}

export function getCover(songId: number): { mime: string; data: Buffer } | null {
  const row = getDb().prepare('SELECT mime, data FROM covers WHERE song_id = ?').get(songId) as
    | { mime: string; data: Buffer }
    | undefined;
  return row ? { mime: row.mime, data: row.data } : null;
}

// ----------------------------- 播放列表 -----------------------------

export function createPlaylist(name: string): Playlist {
  const d = getDb();
  const info = d.prepare('INSERT INTO playlists (name) VALUES (?)').run(name);
  return {
    id: Number(info.lastInsertRowid),
    name,
    songCount: 0,
    createdAt: new Date().toISOString(),
  };
}

export function listPlaylists(): Playlist[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.name, p.created_at, COUNT(ps.song_id) AS song_count
       FROM playlists p LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
       GROUP BY p.id ORDER BY p.created_at DESC`,
    )
    .all() as { id: number; name: string; created_at: string; song_count: number }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    songCount: r.song_count,
    createdAt: r.created_at,
  }));
}

export function addSongToPlaylist(playlistId: number, songId: number): void {
  const d = getDb();
  const max = d
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_songs WHERE playlist_id = ?')
    .get(playlistId) as { m: number };
  d.prepare(
    'INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
  ).run(playlistId, songId, max.m + 1);
}

/** 批量添加歌曲到播放列表（事务保证原子性，自动递增 position） */
export function addSongsToPlaylist(playlistId: number, songIds: number[]): void {
  if (songIds.length === 0) return;
  const d = getDb();
  const max = d
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_songs WHERE playlist_id = ?')
    .get(playlistId) as { m: number };
  let pos = max.m + 1;
  const insert = d.prepare(
    'INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, position) VALUES (?, ?, ?)',
  );
  const tx = d.transaction(() => {
    for (const songId of songIds) {
      insert.run(playlistId, songId, pos++);
    }
  });
  tx();
}

export function getPlaylistSongs(playlistId: number): Song[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SONG_COLUMNS} FROM songs s
       JOIN playlist_songs ps ON ps.song_id = s.id
       WHERE ps.playlist_id = ? ORDER BY ps.position`,
    )
    .all(playlistId) as SongRow[];
  return rows.map(rowToSong);
}

/** 删除播放列表（级联删除 playlist_songs 关联，由外键 ON DELETE CASCADE 处理） */
export function deletePlaylist(playlistId: number): void {
  getDb().prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
}

/** 重命名播放列表 */
export function renamePlaylist(playlistId: number, name: string): void {
  getDb().prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, playlistId);
}

/** 从播放列表中移除一首歌曲 */
export function removeSongFromPlaylist(playlistId: number, songId: number): void {
  getDb()
    .prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?')
    .run(playlistId, songId);
}

// ----------------------------- M3U 导入 -----------------------------

/**
 * 根据文件路径列表批量查找库内歌曲 ID。
 * 匹配策略：
 * 1. 精确路径匹配（file_path 列）
 * 2. 文件名匹配（取路径最后一段，不区分大小写）
 * 返回 Map<原始路径, songId>，未匹配的路径不在 Map 中。
 */
export function findSongIdsByPaths(paths: string[]): Map<string, number> {
  if (paths.length === 0) return new Map();
  const d = getDb();
  const result = new Map<string, number>();

  // 第一轮：精确路径匹配
  const placeholders = paths.map(() => '?').join(',');
  const exactRows = d
    .prepare(`SELECT id, file_path FROM songs WHERE file_path IN (${placeholders})`)
    .all(...paths) as { id: number; file_path: string }[];
  for (const r of exactRows) {
    result.set(r.file_path, r.id);
  }

  // 收集未匹配的路径，尝试文件名匹配
  const unmatched = paths.filter((p) => !result.has(p));
  if (unmatched.length === 0) return result;

  // 构建文件名 → 原始路径 的映射（不区分大小写）
  const filenameMap = new Map<string, string[]>();
  for (const p of unmatched) {
    const fname = path.basename(p).toLowerCase();
    if (!filenameMap.has(fname)) filenameMap.set(fname, []);
    filenameMap.get(fname)!.push(p);
  }

  // 查询库内所有歌曲的 file_path，按文件名匹配
  const allRows = d.prepare('SELECT id, file_path FROM songs').all() as { id: number; file_path: string }[];
  for (const r of allRows) {
    const fname = path.basename(r.file_path).toLowerCase();
    const originals = filenameMap.get(fname);
    if (originals) {
      for (const orig of originals) {
        if (!result.has(orig)) result.set(orig, r.id);
      }
    }
  }

  return result;
}
