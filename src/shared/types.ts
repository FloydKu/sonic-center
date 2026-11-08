/**
 * 主进程与渲染进程共享的类型定义。
 * 既被 src/main（tsconfig.node.json）也被 src/renderer（tsconfig.json）引用，
 * 因此两份 tsconfig 的 include 都加入了 src/shared。
 */

/** 一首歌曲的完整元数据（对应 songs 表一行） */
export interface Song {
  id: number;
  /** 文件绝对路径，作为唯一业务键 */
  filePath: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  /** 作曲人 */
  composer?: string;
  /** 时长（秒） */
  duration: number;
  /** 比特率（bps，如 320000 = 320kbps） */
  bitrate: number;
  /** 容器格式，如 mp3 / flac / wav / m4a */
  format: string;
  /** 文件大小（字节） */
  fileSize: number;
  /** 文件最后修改时间（毫秒时间戳），用于增量扫描 */
  mtime: number;
  /** 是否存在嵌入式封面 */
  hasCover: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** 扫描进度事件（通过 IPC 推送到渲染进程） */
export interface ScanProgress {
  phase: 'scanning' | 'parsing' | 'done';
  current: number;
  total: number;
  currentFile?: string;
}

/** 一次扫描的汇总结果 */
export interface ScanResult {
  /** 本次实际解析的文件数（含新增/更新/跳过解析的未变更） */
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** 库内当前总曲目数 */
  total: number;
}

/** Tag 编辑入参：仅传需要修改的字段 */
export interface TagUpdate {
  title?: string;
  artist?: string;
  album?: string;
  /** 封面图片 base64（不含 data: 前缀）。不传 = 保持不变；传 null = 删除封面 */
  coverBase64?: string | null;
  coverMime?: string;
}

/** getSongs 的查询参数 */
export interface GetSongsOptions {
  limit?: number;
  offset?: number;
  /** 按标题/歌手/专辑模糊搜索 */
  search?: string;
  /** 仅返回某播放列表内的歌曲 */
  playlistId?: number;
  orderBy?: 'title' | 'artist' | 'album' | 'added';
  orderDir?: 'asc' | 'desc';
}

/** 播放列表 */
export interface Playlist {
  id: number;
  name: string;
  songCount: number;
  createdAt: string;
}

// ================ AI 推荐相关类型 ================

/** AI 服务配置（OpenAI 兼容接口） */
export interface AiConfig {
  /** API 地址，如 https://api.openai.com/v1 */
  baseURL: string;
  /** API Key */
  apiKey: string;
  /** 模型名，如 gpt-4o-mini / deepseek-chat */
  model: string;
}

/** 聊天消息（OpenAI messages 格式） */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 测试连接结果 */
export interface AiTestResult {
  ok: boolean;
  message: string;
}

/** 对话完成事件（通过 IPC 推送到渲染进程） */
export interface AiChatEvent {
  /** done=true 表示流结束（含出错中断） */
  done: boolean;
  /** 本次推送的增量文本 */
  chunk?: string;
  /** 本次推送的增量推理内容（推理模型的 reasoning_content 等） */
  reasoning?: string;
  /** 出错时的错误消息 */
  error?: string;
}

// ================ 流媒体播放源相关类型 ================

/** 单首推荐曲目的播放源解析结果 */
export type StreamTrackKind = 'local' | 'audius' | 'preview' | 'none';

export interface ResolvedStreamTrack {
  title: string;
  artist: string;
  kind: StreamTrackKind;
  /** kind=local 时携带完整本地歌曲 */
  song?: Song;
  /** kind=audius/preview 时的音频直链 */
  streamUrl?: string;
  /** 时长（秒）；preview 为约 30 秒试听 */
  duration?: number;
  /** 封面图 URL */
  artworkUrl?: string;
  /** Apple Music 曲目页（preview 来源的归属/跳转链接） */
  trackViewUrl?: string;
}

// ================ MTP 设备相关类型 ================

/** MTP 设备的单个存储设备 (内部存储 / SD 卡等) */
export interface MtpStorage {
  /** 存储名称，如 "Internal storage" / "SD card" */
  name: string;
  /** 总容量 (字节) */
  totalSpace: number;
  /** 可用空间 (字节) */
  freeSpace: number;
}

/** MTP 设备信息 */
export interface MtpDevice {
  /** 设备标识 (FriendlyName，用于 --device 参数匹配) */
  id: string;
  /** 设备显示名称 */
  name: string;
  description?: string;
  manufacturer?: string;
  /** 总容量 (字节) */
  totalSpace: number;
  /** 可用空间 (字节) */
  freeSpace: number;
  /** 各存储设备明细 */
  storages?: MtpStorage[];
}

/** 设备上的文件/文件夹条目 */
export interface MtpFileEntry {
  name: string;
  /** 设备上的完整路径 */
  path: string;
  isFolder: boolean;
  /** 文件大小 (字节)，文件夹为 0 */
  size: number;
  /** 最后修改时间 (ISO 8601)，可能为 null */
  lastModified?: string;
}

/** 上传/增量同步结果 */
export interface MtpUploadResult {
  ok: boolean;
  /** 是否因远程已存在同名同大小文件而跳过 */
  skipped: boolean;
}

// ================ 播放列表同步相关类型 ================

/** 同步进度事件 (通过 IPC 推送到渲染进程) */
export interface SyncProgress {
  phase: 'scanning' | 'diffing' | 'uploading' | 'writing-playlist' | 'done';
  current: number;
  total: number;
  /** 当前处理的文件名 (uploading 阶段) */
  currentFile?: string;
  /** 传输速度 (字节/秒，uploading 阶段) */
  speed?: number;
  /** 整体进度百分比 0-100 (跨越所有阶段的综合进度) */
  percent: number;
}

/** 单首歌曲的同步条目 */
export interface SyncItem {
  song: Song;
  /** 设备上的完整路径，如 \Internal storage\Music\Artist\Album\song.flac */
  remotePath: string;
  /** M3U 中的相对路径，如 ./Artist/Album/song.flac */
  relativePath: string;
}

/**
 * M3U 歌曲路径写法：
 *   - sample   按范例 M3U 中的路径格式（播放器已验证可用的写法）
 *   - musicDir 按配置的音乐目录生成（与播放列表同存储时为相对 M3U 的路径）
 *   - custom   用户自定义路径前缀
 */
export type M3uPathMode = 'sample' | 'musicDir' | 'custom';

/**
 * M3U 路径写法决策：范例与音乐目录两种写法的示例，以及实际采用哪种。
 * 两者指向不同位置或范例不可用时 needsChoice=true，需用户选择后才能同步。
 */
export interface M3uPathPlan {
  /** 实际采用的写法；需要用户选择时为 null */
  mode: M3uPathMode | null;
  needsChoice: boolean;
  /** 按音乐目录生成的路径前缀与示例行 */
  musicDirPrefix: string;
  musicDirExample: string;
  /** 按范例解析出的路径前缀与示例行（范例可用时） */
  samplePrefix?: string;
  sampleExample?: string;
  /** 范例中的歌曲实际所在的设备音乐目录（探测到时） */
  sampleMusicRoot?: string;
  /** 范例不可用的原因（读取失败 / 无可识别的路径行 / 设备上找不到范例中的歌曲）；有值时不能按范例写入 */
  sampleError?: string;
  /** 自定义前缀的示例行（采用自定义时） */
  customExample?: string;
  /** 提示信息 */
  message?: string;
}

/** 设备端同名 M3U 播放列表与本地播放列表的条目对比 */
export interface PlaylistDiff {
  /** 设备上 M3U 的完整路径 */
  remotePath: string;
  /** 设备上是否已存在该 M3U */
  exists: boolean;
  /** 本地有、设备 M3U 中没有的歌曲（本地 filePath） */
  addedFilePaths: string[];
  /** 设备 M3U 中有、本地播放列表已没有的条目（原始路径行） */
  removedEntries: string[];
  /** 两边都有的条目数 */
  unchanged: number;
  /** 条目与顺序完全一致，无需重写 M3U */
  identical: boolean;
}

/** 增量对比结果 */
export interface SyncDiffResult {
  /** 需要上传的新歌 */
  toUpload: SyncItem[];
  /** 已存在可跳过的歌曲 */
  alreadyExist: SyncItem[];
  /** 设备播放列表条目对比（需用户选择路径写法时暂不提供） */
  playlist?: PlaylistDiff;
  /** M3U 路径写法决策 */
  pathPlan?: M3uPathPlan;
}

/** 同步参数 */
export interface SyncParams {
  /** MTP 设备标识 (FriendlyName) */
  deviceId: string;
  /** 要同步的歌曲列表 (从 DB 查询后传入) */
  songs: Song[];
  /** 设备上的音乐目录，如 \Internal storage\Music */
  remoteMusicDir: string;
  /** 播放列表名称 (不含扩展名) */
  playlistName: string;
  /** 设备上的播放列表目录，如 \Internal storage\Playlists */
  remotePlaylistDir: string;
  /** 可选：设备上的范例 M3U 文件路径，同步时模仿其中的歌曲路径格式写入 */
  sampleM3uPath?: string;
  /** 可选：用户选定的 M3U 路径写法（未指定时自动决策，冲突时要求选择） */
  m3uPathMode?: M3uPathMode;
  /** 可选：自定义路径前缀（m3uPathMode='custom' 时使用），如 /storage/XXXX-XXXX/Music/ */
  m3uCustomPrefix?: string;
}

/** M3U 文件导入结果 */
export interface M3uImportResult {
  /** 新建的播放列表 ID */
  playlistId: number;
  /** 播放列表名称（取自 M3U 文件名，不含扩展名） */
  playlistName: string;
  /** M3U 中总的文件条目数 */
  totalEntries: number;
  /** 成功匹配到库内歌曲的数量 */
  matchedCount: number;
}

/** 同步完成结果 */
export interface SyncResult {
  /** 实际上传的文件数 */
  uploaded: number;
  /** 因已存在而跳过的文件数 (含 diff 阶段跳过 + CLI 增量跳过) */
  skipped: number;
  /** 上传失败的文件数 */
  failed: number;
  /** 总文件数 */
  total: number;
  /** 错误消息列表 */
  errors: string[];
  /** 是否写入了 M3U（条目无变化时跳过写入） */
  playlistWritten?: boolean;
  /** M3U 新增条目数 */
  playlistAdded?: number;
  /** M3U 移除条目数 */
  playlistRemoved?: number;
  /** 需要用户选择 M3U 路径写法而中止同步时携带的决策信息 */
  pathPlan?: M3uPathPlan;
  /** 设备无响应（超时/连续失败）而停止上传；批量同步时据此停止后续播放列表 */
  deviceUnresponsive?: boolean;
}

/** 批量同步中单个播放列表的结果 */
export interface BatchSyncEntry {
  playlistId: number;
  playlistName: string;
  /** 未执行时为 undefined（被前面的错误中止 / 播放列表为空被跳过） */
  result?: SyncResult;
  /** 整个列表同步抛出的错误或跳过原因 */
  error?: string;
}
