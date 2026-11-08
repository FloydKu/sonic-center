import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import type {
  Song,
  MtpDevice,
  MtpFileEntry,
  MtpUploadResult,
  SyncProgress,
  SyncItem,
  SyncDiffResult,
  SyncResult,
  SyncParams,
  M3uPathMode,
  M3uPathPlan,
  PlaylistDiff,
} from '../shared/types';
// 范例 M3U 路径格式分析（纯函数模块，无 electron 依赖）
import {
  alignSamplePrefix,
  analyzeM3uPathFormat,
  buildMusicDirPrefix,
  extractM3uEntries,
  normalizeM3uEntry,
  parseCustomPrefix,
  relativeDirPrefix,
  retargetSamplePrefix,
  splitPathSegments,
  stripM3uPrefix,
  type M3uPathFormat,
} from './m3uPathFormat';

// ============================================================================
//  CLI 子进程封装
// ============================================================================

/** 获取 MTP CLI 可执行文件路径 */
function getMtpCliPath(): string {
  const exeName = process.platform === 'win32' ? 'mtp-bridge.exe' : 'mtp-bridge';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mtp-bridge', exeName)
    : path.join(app.getAppPath(), 'resources', 'mtp-bridge', exeName);
}

// MTP 设备同一时刻仅允许一个进程访问（Windows MTP 为独占连接），
// 所有 mtp-bridge 调用通过此队列串行化，避免并发访问导致进程挂起/失败
let mtpQueue: Promise<unknown> = Promise.resolve();
function withMtpLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = mtpQueue.then(fn, fn);
  mtpQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 各操作的执行超时（毫秒）：上传大文件较慢，其余操作通常秒级完成。
 *
 * P1 实测：读取大小元数据与实际内容不符的文件（播放器改写过的 M3U）后，
 * 设备会在随后的某次操作上停顿约 30 秒再正常返回。超时必须明显长于这个停顿——
 * 在设备事务进行中强杀进程会使设备 MTP 服务彻底卡死（资源管理器也无法访问），只能重新插拔。
 */
const MTP_TIMEOUT_UPLOAD_MS = 10 * 60 * 1000;
const MTP_TIMEOUT_DEFAULT_MS = 90 * 1000;
/** 批量上传按"无输出"计时：每完成一个文件输出一行进度，单个文件超过该时长视为设备卡死 */
const MTP_TIMEOUT_UPLOAD_IDLE_MS = 5 * 60 * 1000;
/** 超时强杀后等待进程退出的上限，期间不释放设备锁，避免与残留进程同时访问设备 */
const MTP_KILL_WAIT_MS = 5 * 1000;

/**
 * 解码 CLI 的 stderr：C# 端未指定输出编码，重定向时按控制台代码页输出
 * （中文 Windows 为 GBK），按 UTF-8 解码会使错误信息中的中文路径乱码，
 * 进而导致按路径匹配错误信息的判断失效。stdout 为转义后的 JSON，无此问题。
 */
function decodeStderr(chunks: Buffer[]): string {
  const buf = Buffer.concat(chunks);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString();
    }
  }
}

interface MtpRunOptions {
  timeoutMs?: number;
  /** true 时按"无输出"计时：每收到 stdout 数据重新计时（批量上传） */
  idleTimeout?: boolean;
  /** 以 {"__ 开头的进度行回调（递归扫描进度 / 批量上传逐文件结果） */
  onLine?: (obj: Record<string, unknown>) => void;
}

/**
 * 执行 mtp-bridge.exe 并解析其 JSON 输出。
 *
 * CLI 约定：
 *   - 成功：JSON 输出到 stdout (exit 0)，最后一行为结果；之前可能有 {"__..."} 进度行
 *   - 失败：错误消息输出到 stderr (exit 1)
 *
 * 内置串行队列（MTP 设备独占）与超时保护。超时后强杀子进程，但要等进程真正退出
 * （最多 MTP_KILL_WAIT_MS）才 reject 并释放设备锁，避免下一个进程与残留进程同时访问设备。
 *
 * @throws Error 当进程启动失败、退出码非 0、超时或 JSON 解析失败时
 */
function runMtpBridge<T>(args: string[], options: MtpRunOptions = {}): Promise<T> {
  const { timeoutMs = MTP_TIMEOUT_DEFAULT_MS, idleTimeout = false, onLine } = options;
  return withMtpLock(
    () =>
      new Promise<T>((resolve, reject) => {
        const child = spawn(getMtpCliPath(), args, { windowsHide: true });
        let stdout = '';
        let lineBuf = '';
        const stderrChunks: Buffer[] = [];
        let settled = false;
        let timedOut = false;

        const finish = (err?: Error, value?: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(value as T);
        };
        const timeoutError = () =>
          new Error(
            `MTP 设备无响应（${Math.round(timeoutMs / 1000)}s 内未完成：${args[1] ?? ''}），请重新插拔设备后重试`,
          );
        const onTimeout = () => {
          if (settled || timedOut) return;
          timedOut = true;
          child.kill();
          // 正常情况下 close 事件会在进程退出后 reject；兜底防止 close 迟迟不来
          setTimeout(() => finish(timeoutError()), MTP_KILL_WAIT_MS);
        };
        let timer = setTimeout(onTimeout, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          if (idleTimeout && !timedOut) {
            clearTimeout(timer);
            timer = setTimeout(onTimeout, timeoutMs);
          }
          if (!onLine) return;
          // 增量提取完整行，仅解析进度行（结果 JSON 可能跨多个 chunk，不能逐行当结果）
          lineBuf += text;
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{"__')) continue;
            try {
              onLine(JSON.parse(trimmed) as Record<string, unknown>);
            } catch {
              /* 非法行忽略 */
            }
          }
        });
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        child.on('error', (err) => finish(new Error(`MTP CLI 启动失败: ${err.message}`)));
        child.on('close', (code) => {
          if (timedOut) {
            finish(timeoutError());
            return;
          }
          if (code !== 0) {
            finish(new Error(decodeStderr(stderrChunks).trim() || `MTP CLI 退出码: ${code}`));
            return;
          }
          // 取最后一个完整 JSON 行作为结果（进度行在前，结果 JSON 在最后一行）
          const lines = stdout.trimEnd().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;
            try {
              finish(undefined, JSON.parse(trimmed) as T);
              return;
            } catch {
              /* 继续向前找完整 JSON */
            }
          }
          // 截断过长的 stdout 避免错误消息爆炸
          finish(new Error(`MTP CLI 输出解析失败: ${stdout.slice(0, 200)}`));
        });
      }),
  );
}

function execMtpBridge<T>(args: string[], timeoutMs = MTP_TIMEOUT_DEFAULT_MS): Promise<T> {
  return runMtpBridge<T>(args, { timeoutMs });
}

/** 是否为超时（设备无响应）错误：此时不应再向设备发请求重试 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('MTP 设备无响应');
}

/** 主进程临时文件（批量上传清单 / M3U 内容），用完即删 */
function writeTempFile(prefix: string, content: string): string {
  const file = path.join(os.tmpdir(), `sonic-center-${prefix}-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function removeTempFile(file: string): void {
  fs.promises.unlink(file).catch(() => undefined);
}

// ============================================================================
//  基础 MTP 操作 (直接映射 C# CLI 指令)
// ============================================================================

/** 列出已连接的 MTP 设备 */
export function listDevices(): Promise<MtpDevice[]> {
  return execMtpBridge<MtpDevice[]>(['--action', 'list-devices']);
}

/** 扫描设备中指定目录下的文件和文件夹 (仅当前层级) */
export function scanDevice(
  deviceId: string,
  folderPath: string,
): Promise<MtpFileEntry[]> {
  return execMtpBridge<MtpFileEntry[]>([
    '--action', 'scan',
    '--device', deviceId,
    '--path', folderPath,
  ]);
}

/**
 * 上传/增量同步单个文件到 MTP 设备。
 * C# CLI 内部会检查远程同名同大小文件并自动跳过。
 * 大文件上传较慢，使用更长超时。
 */
export function uploadFile(
  deviceId: string,
  localPath: string,
  remotePath: string,
): Promise<MtpUploadResult> {
  return execMtpBridge<MtpUploadResult>(
    [
      '--action', 'upload',
      '--device', deviceId,
      '--local', localPath,
      '--remote', remotePath,
    ],
    MTP_TIMEOUT_UPLOAD_MS,
  );
}

/** 将 M3U 播放列表内容写入设备（经临时文件传递，不受命令行长度限制） */
export async function writeM3u(
  deviceId: string,
  remotePath: string,
  content: string,
): Promise<{ ok: boolean }> {
  const file = writeTempFile('m3u', content);
  try {
    const result = await execMtpBridge<{ ok: boolean }>([
      '--action', 'write-m3u',
      '--device', deviceId,
      '--remote', remotePath,
      '--content-file', file,
    ]);
    rememberDeviceFile(deviceId, remotePath, content, Buffer.byteLength(content, 'utf8'));
    return result;
  } finally {
    removeTempFile(file);
  }
}

/** 批量上传清单条目（与 C# UploadBatchItem 对应） */
interface UploadBatchItem {
  local: string;
  remote: string;
  /** 设备上已有同名不同大小的文件，需先删除 */
  replace: boolean;
}

interface UploadItemResult {
  index: number;
  ok: boolean;
  skipped: boolean;
  error?: string | null;
}

interface UploadBatchResult {
  ok: boolean;
  done: number;
  aborted: boolean;
  error?: string | null;
}

/**
 * 在一次 MTP 连接内依次上传多个文件；每个文件完成后回调 onItem。
 * 设备连续失败时 C# 端提前停止（aborted）。
 */
async function uploadBatch(
  deviceId: string,
  items: UploadBatchItem[],
  onItem: (result: UploadItemResult) => void,
): Promise<UploadBatchResult> {
  const file = writeTempFile('upload', JSON.stringify(items));
  try {
    return await runMtpBridge<UploadBatchResult>(
      ['--action', 'upload-batch', '--device', deviceId, '--list', file],
      {
        timeoutMs: MTP_TIMEOUT_UPLOAD_IDLE_MS,
        idleTimeout: true,
        onLine: (obj) => {
          if (typeof obj.__upload__ === 'number' && obj.result) onItem(obj.result as UploadItemResult);
        },
      },
    );
  } finally {
    removeTempFile(file);
  }
}

/**
 * MTP 读取不可靠（P1 实测）：播放器改写过的 M3U 在设备上报告的大小会大于实际内容，
 * 读取这类文件会打乱设备的传输状态：随后的某次操作停顿约 30 秒，
 * 或返回上一次传输残留的协议包碎片（如 11 字节乱码）。
 * 因此内容合法即采用（不因大小不符反复重读），只对乱码和偶发 COM 错误重试；
 * 超时说明设备已无响应，不再重试。
 */
const READ_M3U_ATTEMPTS = 3;
/** "not found" 可能是误报，但也可能是真不存在，少试几次 */
const READ_M3U_NOT_FOUND_ATTEMPTS = 2;

/** 文本中出现 NUL、替换符或非常规控制字符 → 视为读取损坏 */
function looksCorrupted(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text);
}

/**
 * 读取设备上的文本文件内容 (如 M3U 播放列表范例)。
 * 乱码、内容为空（设备报告不为空）或偶发 COM 错误时重试。
 */
export async function readM3u(deviceId: string, remotePath: string): Promise<string> {
  let lastError = new Error(`读取失败：${remotePath}`);
  let notFound = 0;
  for (let attempt = 1; attempt <= READ_M3U_ATTEMPTS; attempt++) {
    try {
      const { content, size, expectedSize } = await execMtpBridge<{
        content: string;
        size?: number;
        expectedSize?: number;
      }>(['--action', 'read', '--device', deviceId, '--remote', remotePath]);
      const unexpectedEmpty = !content.trim() && (expectedSize ?? 0) > 0;
      if (!looksCorrupted(content) && !unexpectedEmpty) {
        if (size !== undefined && expectedSize !== undefined && size !== expectedSize) {
          console.warn(`[mtp] ${remotePath} 读到 ${size} 字节，设备报告 ${expectedSize} 字节（元数据滞后）`);
        }
        return content;
      }
      lastError = new Error('设备返回的内容已损坏（多次重试仍为乱码），请重新插拔设备后重试');
    } catch (err) {
      lastError = err as Error;
      if (isTimeoutError(err)) break;
      if (/not found/i.test(lastError.message) && ++notFound >= READ_M3U_NOT_FOUND_ATTEMPTS) break;
    }
    if (attempt < READ_M3U_ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  throw lastError;
}

// ---- 设备文本文件内容缓存 ----

/**
 * 设备上 M3U 的内容缓存（持久化到 userData）：以目录列表中的大小 + 修改时间判断是否变化，
 * 未变化时不再读取。读取设备文件有打乱设备传输状态的风险（见 readM3u），
 * 范例和已同步的播放列表又每次分析/同步都要用到。
 */
interface CachedDeviceFile {
  /** 设备目录列表报告的大小 */
  size: number;
  /** 设备目录列表报告的修改时间；刚写入时未知，下次命中时补全 */
  mtime?: string;
  content: string;
}

let deviceFileCache: Map<string, CachedDeviceFile> | null = null;

function deviceFileCachePath(): string {
  return path.join(app.getPath('userData'), 'mtp-file-cache.json');
}

function getDeviceFileCache(): Map<string, CachedDeviceFile> {
  if (deviceFileCache) return deviceFileCache;
  deviceFileCache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(deviceFileCachePath(), 'utf8')) as Record<string, CachedDeviceFile>;
    for (const [k, v] of Object.entries(raw)) deviceFileCache.set(k, v);
  } catch {
    /* 无缓存或缓存损坏 */
  }
  return deviceFileCache;
}

function saveDeviceFileCache(): void {
  try {
    fs.writeFileSync(deviceFileCachePath(), JSON.stringify(Object.fromEntries(getDeviceFileCache())), 'utf8');
  } catch (err) {
    console.warn('[mtp] 写入设备文件缓存失败:', (err as Error).message);
  }
}

const deviceFileKey = (deviceId: string, remotePath: string) => `${deviceId}::${remotePath.toLowerCase()}`;

function rememberDeviceFile(deviceId: string, remotePath: string, content: string, size: number, mtime?: string): void {
  getDeviceFileCache().set(deviceFileKey(deviceId, remotePath), { size, mtime, content });
  saveDeviceFileCache();
}

/**
 * 读取目录列表中的文件：大小与修改时间未变时直接用缓存内容，否则读取设备并缓存。
 */
async function readDeviceFileCached(deviceId: string, entry: MtpFileEntry): Promise<string> {
  const key = deviceFileKey(deviceId, entry.path);
  const cached = getDeviceFileCache().get(key);
  if (cached && cached.size === entry.size && (!cached.mtime || cached.mtime === entry.lastModified)) {
    if (!cached.mtime && entry.lastModified) rememberDeviceFile(deviceId, entry.path, cached.content, cached.size, entry.lastModified);
    return cached.content;
  }
  const content = await readM3u(deviceId, entry.path);
  rememberDeviceFile(deviceId, entry.path, content, entry.size, entry.lastModified);
  return content;
}

/** 取得设备文件在父目录列表中的条目（用于按大小/修改时间判断缓存是否有效） */
async function findDeviceFile(deviceId: string, remotePath: string): Promise<MtpFileEntry | undefined> {
  const parent = remotePath.replace(/[\\/][^\\/]*$/, '');
  const name = remotePath.slice(parent.length + 1).toLowerCase();
  const entries = await scanDevice(deviceId, parent || '\\');
  return entries.find((e) => !e.isFolder && e.name.toLowerCase() === name);
}

/** 从 MTP 设备删除文件 */
export async function deleteFile(
  deviceId: string,
  remotePath: string,
): Promise<{ ok: boolean }> {
  const result = await execMtpBridge<{ ok: boolean }>([
    '--action', 'delete',
    '--device', deviceId,
    '--remote', remotePath,
  ]);
  // 设备文件已变化，避免增量分析沿用仍含该文件的扫描结果
  invalidateScanCache(deviceId);
  return result;
}

// ============================================================================
//  同步辅助函数
// ============================================================================

/**
 * 清理 MTP/Windows 文件名不允许的字符。
 * 移除 \ / : * ? " < > | ，替换为下划线；并去掉结尾的点和空格：
 * FAT/exFAT（SD 卡）不允许以点结尾的名称，设备会悄悄去掉结尾的点再创建（如专辑「是時候...」
 * 实际变成「是時候」），按原名查找就永远找不到，上传时报 "does not support reading properties for item"。
 */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/[\s.]+$/, '').trim() || 'Unknown';
}

/** 按文件路径去重 (同一首歌可能在播放列表中出现多次) */
function deduplicateByPath(songs: Song[]): Song[] {
  return Array.from(new Map(songs.map((s) => [s.filePath, s])).values());
}

/**
 * 构建歌曲在设备上的远程路径和 M3U 相对路径。
 *
 * 设备目录结构: {remoteMusicDir}\{Artist}\{Album}\{filename}
 * M3U 相对路径:  ./{Artist}/{Album}/{filename}  (相对于音乐根目录)
 *
 * 注意：不同 MTP 播放器对 M3U 路径解析方式不同，写入 M3U 的路径行
 * 由 resolvePathPlan 决定（范例 / 音乐目录 / 自定义前缀），不直接使用 relativePath。
 */
function buildRemotePath(
  song: Song,
  remoteMusicDir: string,
): { remotePath: string; relativePath: string } {
  const artist = sanitizeName(song.artist || 'Unknown Artist');
  const album = sanitizeName(song.album || 'Unknown Album');
  const filename = sanitizeName(path.basename(song.filePath));

  // MTP 路径用反斜杠
  const remotePath = `${remoteMusicDir}\\${artist}\\${album}\\${filename}`;
  // M3U 路径用正斜杠 (M3U 标准)
  const relativePath = `./${artist}/${album}/${filename}`;

  return { remotePath, relativePath };
}

/** 为所有歌曲构建 SyncItem 列表 (去重 + 路径计算)，保持原始顺序 */
function buildSyncItems(songs: Song[], remoteMusicDir: string): SyncItem[] {
  return deduplicateByPath(songs).map((song) => {
    const { remotePath, relativePath } = buildRemotePath(song, remoteMusicDir);
    return { song, remotePath, relativePath };
  });
}

/**
 * 递归扫描设备目录（单进程快速版）：调用 C# scan --recursive 在一次
 * MTP 连接内枚举全部子目录，消除旧版逐目录进程启动开销（~300ms/目录）。
 *
 * 设备文件列表带缓存：同一设备同一根目录的结果缓存 5 分钟，
 * "增量分析 → 确认差异 → 开始同步"连续操作时同步阶段直接复用，不再二次扫描
 * （期间若有其他途径写入了同名文件，批量上传时会按大小判断跳过或覆盖）。
 *
 * 错误处理策略：
 *   - 根目录 "not found" → 视为空设备（首次同步时音乐目录尚未创建），返回空数组
 *   - 其他错误（超时/占用/拔出）→ 抛出，让上层感知设备异常
 *   - 子目录枚举失败 → C# 端已静默跳过
 */
const scanCache = new Map<string, { files: MtpFileEntry[]; ts: number }>();
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

async function scanDeviceRecursiveFast(
  deviceId: string,
  dir: string,
  onProgress?: (p: SyncProgress) => void,
  forceRefresh = false,
): Promise<MtpFileEntry[]> {
  // 缓存命中（未强制刷新且未过期）直接返回，避免重复扫描设备
  const cacheKey = `${deviceId}::${dir.toLowerCase()}`;
  if (!forceRefresh) {
    const hit = scanCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < SCAN_CACHE_TTL_MS) return hit.files;
  }

  const scanOnce = () =>
    runMtpBridge<MtpFileEntry[]>(
      ['--action', 'scan', '--device', deviceId, '--path', dir, '--recursive', '1'],
      {
        // 递归扫描可能耗时较长，放宽至 5 分钟
        timeoutMs: 5 * 60 * 1000,
        // C# 端每 25 个目录输出一行 {"__progress__":N,"__dir__":"..."}
        onLine: (obj) => {
          if (typeof obj.__progress__ !== 'number') return;
          onProgress?.({
            phase: 'scanning',
            current: obj.__progress__,
            total: 0,
            currentFile: String(obj.__dir__ ?? ''),
            percent: 0,
          });
        },
      },
    );

  let files: MtpFileEntry[];
  try {
    files = await scanOnce();
  } catch (err) {
    const msg = (err as Error).message || '';
    // 仅当错误消息包含被请求的目录路径时才可能是"目录不存在"（首次同步）
    if (!(/not found/i.test(msg) && msg.includes(dir))) throw err;
    // P1 偶发假的 not found：在上级目录中确认，确实存在则重扫
    if (!(await folderExists(deviceId, dir))) return [];
    files = await scanOnce();
  }
  // 偶发扫描结果为空：目录本层确有内容则重扫，避免空结果被缓存后把已有歌曲全判为待上传
  if (files.length === 0) {
    const top = await scanDevice(deviceId, dir).catch(() => [] as MtpFileEntry[]);
    if (top.length > 0) files = await scanOnce();
  }
  scanCache.set(cacheKey, { files, ts: Date.now() });
  return files;
}

/** 在上级目录的列表中确认目录是否存在（上级列举失败时视为存在，交由重扫报错） */
async function folderExists(deviceId: string, dir: string): Promise<boolean> {
  const segs = splitPathSegments(dir);
  if (segs.length <= 1) return true;
  const parent = `\\${segs.slice(0, -1).join('\\')}`;
  const name = segs[segs.length - 1];
  try {
    const entries = await scanDevice(deviceId, parent);
    return entries.some((e) => e.isFolder && e.name.toLowerCase() === name.toLowerCase());
  } catch (err) {
    return !/not found/i.test((err as Error).message);
  }
}

/** 使设备扫描缓存失效（上传中断、设备文件状态不确定时调用） */
function invalidateScanCache(deviceId: string): void {
  for (const key of scanCache.keys()) {
    if (key.startsWith(`${deviceId}::`)) scanCache.delete(key);
  }
}

/** 把已确认在设备上的文件补进扫描缓存（同路径旧条目按新大小替换）；未缓存时无需处理 */
function addToScanCache(deviceId: string, dir: string, items: SyncItem[]): void {
  const hit = scanCache.get(`${deviceId}::${dir.toLowerCase()}`);
  if (!hit || items.length === 0) return;
  const added = new Set(items.map((item) => item.remotePath.toLowerCase()));
  const files = hit.files.filter((f) => !added.has(f.path.toLowerCase()));
  for (const item of items) {
    files.push({
      name: item.remotePath.split('\\').pop() ?? '',
      path: item.remotePath,
      isFolder: false,
      size: item.song.fileSize,
    });
  }
  hit.files = files;
}

/**
 * 构建 M3U 播放列表内容。
 *
 * 格式:
 *   #EXTM3U
 *   #EXTINF:{duration},{Artist} - {Title}
 *   ./{Artist}/{Album}/{filename}
 *   ...
 *
 * 歌曲路径按选定的路径写法生成：
 *   {prefix}{Artist}{sep}{Album}{sep}{filename}
 * （目录层级与上传结构一致，前缀与分隔符来自范例 / 音乐目录 / 自定义前缀）
 *
 * 包含全部歌曲 (已上传 + 已存在)，保持播放列表原始顺序。
 */
function buildM3UContent(items: SyncItem[], pathFormat: M3uPathFormat): string {
  const lines: string[] = ['#EXTM3U'];
  for (const item of items) {
    const duration = Math.round(item.song.duration) || -1;
    const title = `${item.song.artist || 'Unknown'} - ${item.song.title || path.basename(item.song.filePath)}`;
    lines.push(`#EXTINF:${duration},${title}`);
    lines.push(buildM3uLine(item, pathFormat));
  }
  return lines.join('\n');
}

/** 按路径写法生成单首歌曲在 M3U 中的路径行 */
function buildM3uLine(item: SyncItem, pathFormat: M3uPathFormat): string {
  const artist = sanitizeName(item.song.artist || 'Unknown Artist');
  const album = sanitizeName(item.song.album || 'Unknown Album');
  const filename = sanitizeName(path.basename(item.song.filePath));
  return `${pathFormat.prefix}${artist}${pathFormat.separator}${album}${pathFormat.separator}${filename}`;
}

/**
 * 执行增量对比核心逻辑：扫描设备目录，对比本地歌曲与设备已有文件。
 *
 * 比对维度：远程完整路径 (含 Artist\Album 结构) + 文件大小 (字节)
 *   - 路径+大小均匹配 → alreadyExist (跳过)
 *   - 否则 → toUpload (需上传)
 *
 * 路径匹配为大小写不敏感 (MTP/Windows 文件系统不区分大小写)。
 *
 * @param onProgress 扫描进度回调 (目录计数，供 UI 展示 "正在扫描设备目录")
 */
async function performDiff(
  deviceId: string,
  items: SyncItem[],
  remoteMusicDir: string,
  onProgress?: (p: SyncProgress) => void,
): Promise<{ toUpload: SyncItem[]; alreadyExist: SyncItem[]; deviceFileMap: Map<string, number> }> {
  // 递归扫描设备上已有的所有文件（单进程快速版，带缓存）
  const deviceFiles = await scanDeviceRecursiveFast(deviceId, remoteMusicDir, (p) => {
    onProgress?.(p);
  });

  // 构建路径 → 文件大小 的快速查找表
  const deviceFileMap = new Map<string, number>();
  for (const f of deviceFiles) {
    if (!f.isFolder) {
      deviceFileMap.set(f.path.toLowerCase(), f.size);
    }
  }

  const toUpload: SyncItem[] = [];
  const alreadyExist: SyncItem[] = [];

  for (const item of items) {
    const existingSize = deviceFileMap.get(item.remotePath.toLowerCase());
    if (existingSize !== undefined && existingSize === item.song.fileSize) {
      alreadyExist.push(item);
    } else {
      toUpload.push(item);
    }
  }

  return { toUpload, alreadyExist, deviceFileMap };
}

/** 范例 M3U 解析结果；不可用时 format 为 null 并给出原因 */
interface SampleM3u {
  entries: string[];
  format: M3uPathFormat | null;
  error?: string;
}

/**
 * 读取范例 M3U 并解析路径格式。
 * 范例大小与修改时间未变时直接用缓存内容（不读设备）；读取失败时沿用上次读到的内容。
 * 无内容可用或无有效路径行时不再静默回退（曾导致写成播放器无法解析的 ./ 路径），
 * 而是带上原因交由 resolvePathPlan 要求用户选择写法。
 */
async function loadSampleM3u(
  deviceId: string,
  sampleM3uPath: string | undefined,
  remoteMusicDir: string,
): Promise<SampleM3u> {
  if (!sampleM3uPath) return { entries: [], format: null };
  let content: string;
  try {
    const entry = await findDeviceFile(deviceId, sampleM3uPath);
    if (!entry) return { entries: [], format: null, error: '设备上找不到该文件' };
    content = await readDeviceFileCached(deviceId, entry);
  } catch (err) {
    const cached = getDeviceFileCache().get(deviceFileKey(deviceId, sampleM3uPath));
    console.warn('[mtp] 范例 M3U 读取失败:', (err as Error).message, cached ? '（沿用上次读取的内容）' : '');
    if (!cached) {
      return { entries: [], format: null, error: `读取失败：${(err as Error).message}` };
    }
    content = cached.content;
  }
  const format = analyzeM3uPathFormat(content, remoteMusicDir);
  return {
    entries: extractM3uEntries(content),
    format,
    error: format ? undefined : '文件中没有可识别的歌曲路径',
  };
}

/** 音乐目录一致性探测时最多抽查的范例条目数（每条一次 MTP 目录枚举） */
const MUSIC_DIR_PROBE_LIMIT = 5;

/** 在候选音乐目录下探测范例条目，返回命中数 */
async function countEntriesUnder(
  deviceId: string,
  musicRoot: string,
  rels: string[][],
): Promise<number> {
  let hits = 0;
  for (const rel of rels) {
    const parent = [musicRoot, ...rel.slice(0, -1)].join('\\');
    const fileName = rel[rel.length - 1].toLowerCase();
    try {
      const entries = await scanDevice(deviceId, parent);
      if (entries.some((e) => !e.isFolder && e.name.toLowerCase() === fileName)) hits++;
    } catch {
      /* 目录不存在，继续下一条 */
    }
  }
  return hits;
}

/** 设备路径比较（忽略分隔符、末尾分隔符与大小写） */
function sameDevicePath(a: string, b: string): boolean {
  return splitPathSegments(a).join('\\').toLowerCase() === splitPathSegments(b).join('\\').toLowerCase();
}

/** 以 baseDir 为基准解析相对路径（支持 ..），越过存储根时返回 null */
function resolveDevicePath(baseDir: string, relative: string): string | null {
  const segs = splitPathSegments(baseDir);
  for (const s of splitPathSegments(relative)) {
    if (s !== '..') segs.push(s);
    else if (segs.length > 1) segs.pop();
    else return null;
  }
  return `\\${segs.join('\\')}`;
}

/**
 * 定位范例 M3U 中的歌曲实际所在的设备音乐目录，用于判断范例写法与配置的
 * 音乐目录是否指向同一位置。
 *
 *   - 相对路径范例：按 M3U 标准以范例所在目录为基准解析（P1 即如此），
 *     解析位置找不到歌曲说明范例本身无法播放
 *   - 绝对路径范例：先查配置的音乐目录，再查各存储下的同名目录
 *     （如 \内部存储设备\Music → \disk\Music）与前缀本身对应的目录
 *
 * 命中过半才算所在目录（不能只看是否命中：错传的副本也会命中少量条目）。
 * 配置的音乐目录用已扫描的设备文件表全量统计，其余目录抽查。
 *
 * @returns 设备音乐目录（如 \disk\Music）；无法定位时返回 null
 */
async function locateSampleMusicRoot(
  deviceId: string,
  remoteMusicDir: string,
  sampleM3uPath: string,
  sampleEntries: string[],
  format: M3uPathFormat,
  deviceFileMap: Map<string, number>,
): Promise<string | null> {
  const rels = sampleEntries
    .map((e) => stripM3uPrefix(e, format))
    .filter((r): r is string[] => r !== null);
  if (rels.length === 0) return null;

  const musicRoot = remoteMusicDir.replace(/[\\/]+$/, '');
  const probes = rels.slice(0, MUSIC_DIR_PROBE_LIMIT);
  const holdsSample = async (root: string): Promise<boolean> => {
    if (sameDevicePath(root, musicRoot)) {
      const found = rels.filter((r) =>
        deviceFileMap.has(`${musicRoot}\\${r.join('\\')}`.toLowerCase()),
      ).length;
      return found * 2 >= rels.length;
    }
    return (await countEntriesUnder(deviceId, root, probes)) * 2 > probes.length;
  };

  if (!/^[\\/]/.test(format.prefix)) {
    const sampleDir = sampleM3uPath.replace(/[\\/][^\\/]*$/, '');
    const root = resolveDevicePath(sampleDir, format.prefix);
    return root && (await holdsSample(root)) ? root : null;
  }

  if (await holdsSample(musicRoot)) return musicRoot;

  let storages: MtpFileEntry[] = [];
  try {
    storages = (await scanDevice(deviceId, '\\')).filter((e) => e.isFolder);
  } catch {
    /* 枚举存储失败时视为无法定位 */
  }
  const subPath = splitPathSegments(musicRoot).slice(1).join('\\');
  const candidates = storages.map((s) => (subPath ? `${s.path}\\${subPath}` : s.path));
  // 前缀本身即设备路径时（如 /disk/Music/）也作为候选
  const prefixSegs = splitPathSegments(format.prefix);
  if (prefixSegs.length > 0 && storages.some((s) => s.name.toLowerCase() === prefixSegs[0].toLowerCase())) {
    candidates.push(`\\${prefixSegs.join('\\')}`);
  }
  const tried = new Set([splitPathSegments(musicRoot).join('\\').toLowerCase()]);
  for (const candidate of candidates) {
    const key = splitPathSegments(candidate).join('\\').toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    if (await holdsSample(candidate)) return candidate;
  }
  return null;
}

/** 范例写法换算到配置的音乐目录后的结果 */
interface SampleTarget {
  /** 范例歌曲实际所在的设备目录（无法定位时为 null） */
  musicRoot: string | null;
  /** 指向配置音乐目录的范例写法；无法换算时为 null */
  format: M3uPathFormat | null;
  /** 范例歌曲不在音乐目录，前缀已换算到音乐目录 */
  retargeted?: boolean;
  /** 绝对路径范例无法在设备上核对，原样沿用其前缀 */
  unverified?: boolean;
  /** format 为 null 的原因 */
  error?: string;
}

/**
 * 把范例的写法套用到配置的音乐目录（歌曲文件拷贝到音乐目录，M3U 写法跟随范例）：
 *   - 绝对路径范例（如 /storage/3434-3662/Music/...）：播放器路径无法直接映射到 MTP 路径，
 *     用音乐目录下的实际文件反推前缀；范例歌曲在同存储的其他目录时换算前缀；
 *     设备上找不到范例歌曲时无法核对，原样沿用范例前缀并提示
 *   - 相对路径范例：以 M3U 所在目录为基准，按播放列表目录→音乐目录重新计算；
 *     解析位置找不到歌曲说明范例本身无法播放（如 P1 上的 ./Artist/...），不予采用
 *
 * @returns 未配置范例或范例不可解析时返回 null
 */
async function resolveSampleTarget(
  params: SyncParams,
  sample: SampleM3u,
  deviceFileMap: Map<string, number>,
): Promise<SampleTarget | null> {
  const { deviceId, remoteMusicDir, remotePlaylistDir, sampleM3uPath } = params;
  const format = sample.format;
  if (!format || !sampleM3uPath) return null;
  const musicRoot = remoteMusicDir.replace(/[\\/]+$/, '');
  const absolute = /^[\\/]/.test(format.prefix);

  if (absolute) {
    const aligned = alignSamplePrefix(sample.entries, format, musicRoot, (p) =>
      deviceFileMap.has(p.toLowerCase()),
    );
    if (aligned) return { musicRoot, format: aligned };
  }

  const root = await locateSampleMusicRoot(
    deviceId,
    musicRoot,
    sampleM3uPath,
    sample.entries,
    format,
    deviceFileMap,
  );
  if (!root) {
    return absolute
      ? { musicRoot: null, format, unverified: true }
      : { musicRoot: null, format: null, error: '设备上找不到范例中的歌曲，范例本身无法播放' };
  }
  const prefix = absolute
    ? retargetSamplePrefix(format.prefix, root, musicRoot, format.separator)
    : relativeDirPrefix(remotePlaylistDir, musicRoot, format.separator);
  if (prefix === null) {
    return {
      musicRoot: root,
      format: null,
      error: `范例歌曲位于 ${root}，与音乐目录 ${remoteMusicDir} 不在同一存储，无法按范例写法换算`,
    };
  }
  return {
    musicRoot: root,
    format: { prefix, separator: format.separator },
    retargeted: !sameDevicePath(root, musicRoot),
  };
}

/**
 * 决定写入 M3U 的歌曲路径写法（音乐目录只决定歌曲文件拷贝到哪里）：
 *   - 用户已选择写法且可用 → 按用户选择
 *   - 未配置范例 → 按音乐目录
 *   - 配置了范例 → 按范例写法（播放器自己写的路径最可靠），前缀换算到音乐目录
 *   - 范例读不到、无法播放或无法换算 → needsChoice，由用户选择
 *
 * @returns plan 供 UI 展示；format 为实际采用的写法，需要选择时为 null
 */
function resolvePathPlan(
  params: SyncParams,
  items: SyncItem[],
  sample: SampleM3u,
  target: SampleTarget | null,
): { plan: M3uPathPlan; format: M3uPathFormat | null } {
  const { remoteMusicDir, remotePlaylistDir } = params;
  const sampleFormat = target?.format ?? null;
  const separator = sample.format?.separator ?? '/';
  // 仅绝对路径范例能推出存储在播放器中的根路径（相对路径以范例所在目录为基准）
  const sampleHint =
    sampleFormat && target?.musicRoot && /^[\\/]/.test(sampleFormat.prefix)
      ? { prefix: sampleFormat.prefix, musicRoot: remoteMusicDir }
      : undefined;
  const musicDirFormat: M3uPathFormat = {
    prefix: buildMusicDirPrefix(remoteMusicDir, remotePlaylistDir, separator, sampleHint),
    separator,
  };
  const customFormat = parseCustomPrefix(params.m3uCustomPrefix ?? '');
  const exampleOf = (f: M3uPathFormat) => (items[0] ? buildM3uLine(items[0], f) : f.prefix);
  const shownSample = sampleFormat ?? sample.format;

  const base: M3uPathPlan = {
    mode: null,
    needsChoice: false,
    musicDirPrefix: musicDirFormat.prefix,
    musicDirExample: exampleOf(musicDirFormat),
    samplePrefix: shownSample?.prefix,
    sampleExample: shownSample ? exampleOf(shownSample) : undefined,
    sampleMusicRoot: target?.musicRoot ?? undefined,
    sampleError: sample.error ?? target?.error,
    customExample: customFormat ? exampleOf(customFormat) : undefined,
  };
  const use = (mode: M3uPathMode, format: M3uPathFormat, message?: string) => ({
    plan: { ...base, mode, message },
    format,
  });
  const askUser = (message: string) => ({
    plan: { ...base, needsChoice: true, message },
    format: null,
  });
  const sampleNote = !sampleFormat
    ? undefined
    : target?.retargeted
      ? `范例歌曲位于 ${target.musicRoot}，与音乐目录 ${remoteMusicDir} 不同，已按范例写法换算为音乐目录的路径（${sampleFormat.prefix}）。`
      : target?.unverified
        ? `未在音乐目录 ${remoteMusicDir} 中找到范例里的歌曲，无法核对前缀，已直接沿用范例前缀 ${sampleFormat.prefix}；` +
          '请确认它在播放器中对应该音乐目录，否则请改用自定义前缀。'
        : undefined;

  if (params.m3uPathMode === 'custom' && customFormat) return use('custom', customFormat);
  if (params.m3uPathMode === 'musicDir') return use('musicDir', musicDirFormat);
  if (params.m3uPathMode === 'sample' && sampleFormat) return use('sample', sampleFormat, sampleNote);

  if (!params.sampleM3uPath) {
    const crossStorage = !sameDevicePath(
      splitPathSegments(remoteMusicDir)[0] ?? '',
      splitPathSegments(remotePlaylistDir)[0] ?? '',
    );
    return use(
      'musicDir',
      musicDirFormat,
      crossStorage
        ? `音乐目录与播放列表目录不在同一存储，播放器未必能识别 ${musicDirFormat.prefix} 这种写法；` +
            '可指定一个在播放器内创建的范例播放列表，或使用自定义前缀（如 Android 播放器的 /storage/XXXX-XXXX/Music/）。'
        : undefined,
    );
  }
  if (!sample.format) {
    return askUser(`范例播放列表不可用（${sample.error}），无法确认播放器识别的路径写法，请选择歌曲路径的写法。`);
  }
  if (!sampleFormat) {
    return askUser(`${target?.error ?? '范例写法无法套用到音乐目录'}，请选择歌曲路径的写法。`);
  }
  return use('sample', sampleFormat, sampleNote);
}

/**
 * 与设备上已有的同名 M3U 对比条目：得出新增/移除/不变的条目，
 * 条目与顺序完全一致时标记 identical，同步时跳过重写。
 *
 * 路径行按 buildM3uLine 生成后规范化比较（分隔符/大小写/./ 不敏感）。
 */
async function diffDevicePlaylist(
  deviceId: string,
  remotePlaylistDir: string,
  playlistName: string,
  items: SyncItem[],
  pathFormat: M3uPathFormat,
): Promise<PlaylistDiff> {
  const fileName = `${sanitizeName(playlistName)}.m3u`;
  // 先列目录判断 M3U 是否存在，避免依赖"文件不存在"的错误文案
  let listing: MtpFileEntry[] = [];
  try {
    listing = await scanDevice(deviceId, remotePlaylistDir);
  } catch {
    /* 播放列表目录不存在 → 新建 */
  }
  const found = listing.find((e) => !e.isFolder && e.name.toLowerCase() === fileName.toLowerCase());
  let existing: string[] | null = null;
  if (found) {
    try {
      existing = extractM3uEntries(await readDeviceFileCached(deviceId, found));
    } catch (err) {
      // 读不到旧内容时无法对比，按整份重写处理
      console.warn('[mtp] 设备播放列表读取失败，将整份重写:', (err as Error).message);
      existing = [];
    }
  }

  const desired = items.map((item) => ({
    filePath: item.song.filePath,
    key: normalizeM3uEntry(buildM3uLine(item, pathFormat)),
  }));
  const existingKeys = (existing ?? []).map(normalizeM3uEntry);
  const existingSet = new Set(existingKeys);
  const desiredSet = new Set(desired.map((d) => d.key));

  const addedFilePaths = desired.filter((d) => !existingSet.has(d.key)).map((d) => d.filePath);
  const removedEntries = (existing ?? []).filter((_, i) => !desiredSet.has(existingKeys[i]));
  const identical =
    existing !== null &&
    existingKeys.length === desired.length &&
    existingKeys.every((k, i) => k === desired[i].key);

  return {
    remotePath: found?.path ?? `${remotePlaylistDir}\\${fileName}`,
    exists: existing !== null,
    addedFilePaths,
    removedEntries,
    unchanged: desired.length - addedFilePaths.length,
    identical,
  };
}

/** 同步计划：增量分析与正式同步共用同一套对比结果 */
interface SyncPlan {
  items: SyncItem[];
  toUpload: SyncItem[];
  alreadyExist: SyncItem[];
  /** 设备音乐目录文件路径(小写) → 大小 */
  deviceFileMap: Map<string, number>;
  /** 实际采用的 M3U 路径写法；需要用户选择时为 null */
  pathFormat: M3uPathFormat | null;
  pathPlan: M3uPathPlan;
  /** 设备同名 M3U 条目对比（路径写法未定时无法对比） */
  playlist?: PlaylistDiff;
}

/**
 * 生成同步计划：
 *   1. 扫描设备音乐目录，按路径+大小得出需上传/已存在的文件
 *   2. 读取范例 M3U，定位范例歌曲所在目录并决定 M3U 路径写法
 *   3. 写法确定后与设备上同名 M3U 对比播放列表条目
 */
async function prepareSync(
  params: SyncParams,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncPlan> {
  const { deviceId, remoteMusicDir } = params;
  if (!remoteMusicDir.trim()) {
    throw new Error('请填写音乐目录：歌曲文件会拷贝到该目录（M3U 中的路径写法仍按范例文件）');
  }
  const items = buildSyncItems(params.songs, remoteMusicDir);
  const { toUpload, alreadyExist, deviceFileMap } = await performDiff(
    deviceId,
    items,
    remoteMusicDir,
    onProgress,
  );
  const sample = await loadSampleM3u(deviceId, params.sampleM3uPath, remoteMusicDir);
  const target = await resolveSampleTarget(params, sample, deviceFileMap);
  const { plan: pathPlan, format: pathFormat } = resolvePathPlan(params, items, sample, target);
  const playlist = pathFormat
    ? await diffDevicePlaylist(
        deviceId,
        params.remotePlaylistDir,
        params.playlistName,
        items,
        pathFormat,
      )
    : undefined;
  return { items, toUpload, alreadyExist, deviceFileMap, pathFormat, pathPlan, playlist };
}

// ============================================================================
//  同步编排 API
// ============================================================================

/**
 * 计算同步差异 (不执行上传)。
 * 用于 UI 展示"将要同步哪些文件、播放列表如何变化"的预览，让用户确认后再执行同步。
 *
 * @example
 * const diff = await computeSyncDiff({
 *   deviceId: 'WALKMAN',
 *   songs: playlistSongs,
 *   remoteMusicDir: '\\Internal storage\\Music',
 *   playlistName: 'My List',
 *   remotePlaylistDir: '\\Internal storage\\Playlists',
 * });
 * console.log(`需上传: ${diff.toUpload.length}, 已存在: ${diff.alreadyExist.length}`);
 */
export async function computeSyncDiff(
  params: SyncParams,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncDiffResult> {
  if (params.songs.length === 0) {
    return { toUpload: [], alreadyExist: [] };
  }
  const plan = await prepareSync(params, onProgress);
  return {
    toUpload: plan.toUpload,
    alreadyExist: plan.alreadyExist,
    playlist: plan.playlist,
    pathPlan: plan.pathPlan,
  };
}

/**
 * 同步播放列表到 MTP 设备 (完整流程)。
 *
 * 流程:
 *   1. 扫描设备音乐目录 + 读取范例与设备同名 M3U → phase: scanning  (5%)
 *   2. 增量对比得出 toUpload/alreadyExist 与播放列表差异 → phase: diffing  (10%)
 *   3. 单连接批量上传 toUpload，逐首报告进度 → phase: uploading (10%~90%)
 *   4. 播放列表条目有变化时重写 M3U     → phase: writing-playlist (95%)
 *   5. 完成                              → phase: done (100%)
 *
 * 错误处理策略:
 *   - M3U 路径写法需要用户选择（范例不可用或与音乐目录不一致）→ 中止，不上传不写入
 *   - 单个上传失败 → 记录错误，继续下一个
 *   - 连续失败或超时（设备无响应）→ 停止上传，且不写播放列表，避免在设备卡住时继续写入
 *   - M3U 写入失败 → 记录错误，但仍返回同步结果 (文件已上传)
 *
 * @param params 同步参数
 * @param onProgress 进度回调 (通过 IPC 推送到渲染进程)
 * @returns 同步汇总结果
 */
export async function syncPlaylistToDevice(
  params: SyncParams,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const { deviceId, songs } = params;

  if (songs.length === 0) {
    onProgress?.({ phase: 'done', current: 0, total: 0, percent: 100 });
    return { uploaded: 0, skipped: 0, failed: 0, total: 0, errors: [] };
  }

  // ---- Phase 1: 扫描设备 ----
  onProgress?.({ phase: 'scanning', current: 0, total: 1, percent: 5 });

  // performDiff 内部已处理"目录不存在 → 空设备"；此处抛出的均为设备级异常
  // （超时/被占用/已拔出），终止同步而非盲目全量上传
  const plan = await prepareSync(params, (p) =>
    onProgress?.({ ...p, percent: Math.max(5, Math.round(p.percent / 10)) }),
  );
  const { items, toUpload, alreadyExist, playlist, pathFormat, deviceFileMap } = plan;
  const total = items.length;

  // 路径写法未定：写入的播放列表可能找不到歌曲，中止并返回决策信息供用户选择
  if (!pathFormat || !playlist) {
    onProgress?.({ phase: 'done', current: 0, total, percent: 100 });
    return {
      uploaded: 0,
      skipped: 0,
      failed: 0,
      total,
      errors: [],
      playlistWritten: false,
      pathPlan: plan.pathPlan,
    };
  }

  // ---- Phase 2: 对比完成 ----
  onProgress?.({
    phase: 'diffing',
    current: total,
    total,
    percent: 10,
  });

  // ---- Phase 3: 批量上传（整批共用一次 MTP 连接）----
  let uploaded = 0;
  let cliSkipped = 0; // CLI 层面二次跳过 (diff 后到 upload 之间文件可能被其他途径写入)
  let failed = 0;
  const errors: string[] = [];
  /** 设备无响应（超时/连续失败）：不再写入播放列表，避免继续向卡死的设备发请求 */
  let deviceUnresponsive = false;
  /** 上传过程异常中断：设备上的文件状态不确定，需重新扫描 */
  let uploadInterrupted = false;
  /** 已确认在设备上的文件（上传成功或 CLI 判定已存在） */
  const landed: SyncItem[] = [];

  if (toUpload.length > 0) {
    const nameOf = (item: SyncItem) => item.song.title || path.basename(item.song.filePath);
    const percentAt = (done: number) => 10 + Math.round((done / toUpload.length) * 80);
    let finished = 0;
    let lastAt = Date.now();
    onProgress?.({
      phase: 'uploading',
      current: 1,
      total: toUpload.length,
      currentFile: nameOf(toUpload[0]),
      percent: percentAt(0),
    });

    try {
      const batch = await uploadBatch(
        deviceId,
        toUpload.map((item) => ({
          local: item.song.filePath,
          remote: item.remotePath,
          replace: deviceFileMap.has(item.remotePath.toLowerCase()),
        })),
        (r) => {
          const item = toUpload[r.index];
          if (!item) return;
          finished = r.index + 1;
          if (!r.ok) {
            failed++;
            errors.push(`${nameOf(item)}: ${r.error ?? '上传失败'}`);
          } else if (r.skipped) {
            cliSkipped++;
            landed.push(item);
          } else {
            uploaded++;
            landed.push(item);
          }
          const now = Date.now();
          const elapsedSec = (now - lastAt) / 1000;
          lastAt = now;
          const next = toUpload[finished];
          onProgress?.({
            phase: 'uploading',
            current: Math.min(finished + 1, toUpload.length),
            total: toUpload.length,
            currentFile: next ? nameOf(next) : nameOf(item),
            speed: r.ok && !r.skipped && elapsedSec > 0 ? Math.round(item.song.fileSize / elapsedSec) : undefined,
            percent: percentAt(finished),
          });
        },
      );
      if (batch.aborted) {
        deviceUnresponsive = true;
        uploadInterrupted = true;
        errors.push(batch.error ?? '设备无响应，已停止上传');
      }
    } catch (err) {
      deviceUnresponsive = isTimeoutError(err);
      uploadInterrupted = true;
      errors.push(`上传中断: ${(err as Error).message}`);
    }

    // 未执行到的文件计为失败（下次同步会重新上传，已上传的不会重复）
    const notAttempted = toUpload.length - finished;
    if (notAttempted > 0) {
      failed += notAttempted;
      errors.push(`另有 ${notAttempted} 首未上传（再次同步时会继续，已上传的歌曲不会重复上传）`);
    }
  }

  // 设备文件已变化：正常完成时把已上传的文件补进扫描缓存（连续同步多个播放列表时
  // 后续列表不必重新递归扫描整个音乐目录）；中断时状态不确定，使缓存失效
  if (uploadInterrupted) invalidateScanCache(deviceId);
  else addToScanCache(deviceId, params.remoteMusicDir, landed);

  // ---- Phase 4: 写入 M3U 播放列表 ----
  // 设备上同名 M3U 条目与顺序均未变化时不重写；否则按本地播放列表生成
  // （MTP 不支持追加写入，只能整份替换；路径按选定写法生成）
  let playlistWritten = false;
  if (deviceUnresponsive) {
    errors.push('设备无响应，未写入播放列表：请重新插拔设备后再次同步');
  } else if (!playlist.identical) {
    onProgress?.({
      phase: 'writing-playlist',
      current: 0,
      total: 1,
      percent: 95,
    });
    try {
      await writeM3u(deviceId, playlist.remotePath, buildM3UContent(items, pathFormat));
      playlistWritten = true;
    } catch (err) {
      errors.push(`播放列表写入失败: ${(err as Error).message}`);
    }
  }

  // ---- Phase 5: 完成 ----
  onProgress?.({ phase: 'done', current: total, total, percent: 100 });

  return {
    uploaded,
    skipped: alreadyExist.length + cliSkipped,
    failed,
    total,
    errors,
    playlistWritten,
    playlistAdded: playlistWritten ? playlist.addedFilePaths.length : 0,
    playlistRemoved: playlistWritten ? playlist.removedEntries.length : 0,
    deviceUnresponsive,
  };
}
