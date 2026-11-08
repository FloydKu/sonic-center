/**
 * M3U 路径格式分析 —— 从设备上可正常播放的范例 M3U 中
 * 提取歌曲路径格式（前缀 + 分隔符），供同步时模仿生成。
 *
 * 独立模块（无 electron 依赖）：不同播放器对 M3U 相对路径的解析基准各异
 * （音乐根目录 / M3U 所在目录），写入格式必须与播放器约定一致，
 * 因此通过用户指定的范例文件反推格式。
 */

/** 从范例 M3U 提取的歌曲路径格式 */
export interface M3uPathFormat {
  /** 路径前缀（如 '../Music/'、'/disk/Music/'、'\\内部存储设备\\Music\\'），可为空串 */
  prefix: string;
  /** 路径分隔符 '/' 或 '\\' */
  separator: string;
}

/** 将 M3U 路径拆为段（保留 .. 段，去除空段与当前目录段） */
export function splitPathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}

/** 提取 M3U 内容中的歌曲路径行（去除 BOM、注释与空行） */
export function extractM3uEntries(content: string): string[] {
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** M3U 路径行规范化（统一分隔符、去 ./、忽略大小写），用于条目比对 */
export function normalizeM3uEntry(entry: string): string {
  return splitPathSegments(entry).join('/').toLowerCase();
}

/**
 * 按路径格式去掉条目前缀，得到相对音乐根目录的路径段（Artist/Album/file）。
 * 条目不以该前缀开头时返回 null。
 */
export function stripM3uPrefix(entry: string, format: M3uPathFormat): string[] | null {
  const prefixSegs = splitPathSegments(format.prefix);
  const segs = splitPathSegments(entry);
  if (segs.length <= prefixSegs.length) return null;
  for (let i = 0; i < prefixSegs.length; i++) {
    if (segs[i].toLowerCase() !== prefixSegs[i].toLowerCase()) return null;
  }
  return segs.slice(prefixSegs.length);
}

/** 路径段比较（忽略大小写） */
function segEq(a?: string, b?: string): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * 同一存储内从 fromDir 指向 toDir 的相对路径前缀（M3U 标准：相对 M3U 所在目录），
 * 如 \内部存储设备\Playlists → \内部存储设备\Music 得 ../Music/；不同存储返回 null。
 */
export function relativeDirPrefix(fromDir: string, toDir: string, separator: string): string | null {
  const from = splitPathSegments(fromDir);
  const to = splitPathSegments(toDir);
  if (to.length === 0 || !segEq(to[0], from[0])) return null;
  let common = 0;
  while (common < to.length && common < from.length && segEq(to[common], from[common])) common++;
  const rel = [...Array<string>(from.length - common).fill('..'), ...to.slice(common)];
  return rel.length > 0 ? rel.join(separator) + separator : '';
}

/**
 * 把范例的绝对路径前缀从范例歌曲所在目录换算到同一存储下的另一音乐目录，
 * 如范例 /storage/3434-3662/Music/ 对应 \disk\Music，换算到 \disk\Music2 得 /storage/3434-3662/Music2/。
 * 不同存储，或范例前缀尾段与其所在目录对不上时返回 null。
 */
export function retargetSamplePrefix(
  samplePrefix: string,
  sampleRoot: string,
  musicDir: string,
  separator: string,
): string | null {
  const root = splitPathSegments(sampleRoot);
  const music = splitPathSegments(musicDir);
  const prefixSegs = splitPathSegments(samplePrefix);
  const rootSub = root.slice(1);
  const base = prefixSegs.length - rootSub.length;
  if (!segEq(root[0], music[0]) || base < 0 || !rootSub.every((s, i) => segEq(prefixSegs[base + i], s))) {
    return null;
  }
  const segs = [...prefixSegs.slice(0, base), ...music.slice(1)];
  const lead = /^[\\/]/.test(samplePrefix) ? separator : '';
  return segs.length > 0 ? lead + segs.join(separator) + separator : lead;
}

/**
 * 用设备上的实际文件把范例前缀精确对齐到音乐目录：对每条范例路径找出在音乐目录下
 * 真实存在的尾部（如 岛屿心情/？1/影子.mp3），其余部分即播放器中该音乐目录的写法
 * （如 /storage/3434-3662/Music/）。比按关键字推断可靠，不会把歌手/专辑段并入前缀。
 *
 * @param hasFile 设备文件是否存在（参数为 \存储\目录\文件 形式的 MTP 路径）
 * @returns 过半条目对齐到同一前缀时返回该写法，否则 null（范例歌曲不在该音乐目录）
 */
export function alignSamplePrefix(
  entries: string[],
  format: M3uPathFormat,
  musicDir: string,
  hasFile: (devicePath: string) => boolean,
): M3uPathFormat | null {
  const root = splitPathSegments(musicDir).join('\\');
  if (!root || entries.length === 0) return null;
  const votes = new Map<string, { segs: string[]; count: number }>();
  for (const entry of entries) {
    const segs = splitPathSegments(entry);
    // 优先匹配最长的尾部，避免与音乐目录根下的同名文件误配
    for (let k = segs.length - 1; k >= 1; k--) {
      if (!hasFile(`\\${root}\\${segs.slice(segs.length - k).join('\\')}`)) continue;
      const prefixSegs = segs.slice(0, segs.length - k);
      const key = prefixSegs.join('/').toLowerCase();
      const vote = votes.get(key) ?? { segs: prefixSegs, count: 0 };
      vote.count++;
      votes.set(key, vote);
      break;
    }
  }
  let best: { segs: string[]; count: number } | null = null;
  for (const v of votes.values()) if (!best || v.count > best.count) best = v;
  if (!best || best.count * 2 < entries.length) return null;

  const lead = /^[\\/]/.test(entries[0]) ? format.separator : '';
  const prefix = best.segs.length > 0 ? lead + best.segs.join(format.separator) + format.separator : lead;
  return { prefix, separator: format.separator };
}

/**
 * 按配置的音乐目录生成 M3U 路径前缀（拼接 Artist/Album/file 即为歌曲路径行）。
 *
 *   1. 音乐目录与播放列表目录在同一存储 → 相对 M3U 所在目录的路径（M3U 标准），
 *      如 \内部存储设备\Playlists + \内部存储设备\Music → ../Music/
 *   2. 不同存储且范例歌曲位于音乐目录同一存储 → 借范例推出该存储在播放器中的根路径，
 *      如范例 /storage/3434-3662/Music/ 对应 \disk\Music → \disk 即 /storage/3434-3662
 *   3. 否则回退为设备路径的绝对写法，如 /disk/Music/（播放器未必能解析）
 */
export function buildMusicDirPrefix(
  musicDir: string,
  playlistDir: string,
  separator: string,
  sample?: { prefix: string; musicRoot: string },
): string {
  const relative = relativeDirPrefix(playlistDir, musicDir, separator);
  if (relative !== null) return relative;

  if (sample) {
    const retargeted = retargetSamplePrefix(sample.prefix, sample.musicRoot, musicDir, separator);
    if (retargeted !== null) return retargeted;
  }

  return separator + splitPathSegments(musicDir).join(separator) + separator;
}

/** 规范化用户输入的自定义前缀：推断分隔符并补齐末尾分隔符；空串返回 null */
export function parseCustomPrefix(input: string): M3uPathFormat | null {
  const prefix = input.trim();
  if (!prefix) return null;
  const separator = prefix.includes('\\') && !prefix.includes('/') ? '\\' : '/';
  return { prefix: /[\\/]$/.test(prefix) ? prefix : prefix + separator, separator };
}

/**
 * 分析范例 M3U 内容，提取歌曲路径的前缀与分隔符。
 *
 * 算法：
 *   1. 提取所有非 # 开头的路径行
 *   2. 统计分隔符（取出现次数多者）
 *   3. 计算所有行的公共目录前缀段
 *   4. 将前缀对齐到配置的音乐目录（防止歌手段被误并入前缀）：
 *      优先匹配音乐目录尾段；其次找含 music/音乐 关键字的段；
 *      再其次公共前缀 ≥2 段时去掉末段；否则空前缀
 *
 * 生成路径 = prefix + Artist + sep + Album + sep + filename（与上传结构一致）
 *
 * @returns 解析失败（无有效路径行）返回 null，调用方回退默认格式
 */
export function analyzeM3uPathFormat(
  sampleContent: string,
  remoteMusicDir: string,
): M3uPathFormat | null {
  const lines = extractM3uEntries(sampleContent);
  if (lines.length === 0) return null;

  // ---- 分隔符统计 ----
  let slashes = 0;
  let backslashes = 0;
  for (const line of lines) {
    for (const ch of line) {
      if (ch === '/') slashes++;
      else if (ch === '\\') backslashes++;
    }
  }
  const separator = backslashes > slashes ? '\\' : '/';

  // ---- 公共目录前缀段 ----
  const segLists = lines.map(splitPathSegments);
  // 至少需要一段目录 + 文件名；不足则无法分析
  if (!segLists.some((l) => l.length >= 2)) return null;

  let common = 0;
  outer: while (true) {
    const seg = segLists[0][common];
    if (seg === undefined) break;
    for (const list of segLists) {
      // 公共前缀不能吃掉最后的文件名段
      if (list.length <= common + 1) break outer;
      if (list[common] !== seg) break outer;
    }
    common++;
  }

  const firstSegments = segLists[0];

  // ---- 前缀对齐：优先匹配音乐目录尾段序列 ----
  const musicSegs = splitPathSegments(remoteMusicDir);
  let prefixEnd = -1; // 前缀截止段索引（含）
  if (musicSegs.length > 0) {
    const musicTail = musicSegs[musicSegs.length - 1].toLowerCase();
    for (let i = 0; i < common; i++) {
      if (firstSegments[i].toLowerCase() !== musicTail) continue;
      // 检查音乐目录前置段是否也匹配（从后往前）
      let ok = true;
      for (let j = 1; j < musicSegs.length; j++) {
        const idx = i - j;
        const musicIdx = musicSegs.length - 1 - j;
        if (idx < 0 || firstSegments[idx].toLowerCase() !== musicSegs[musicIdx].toLowerCase()) {
          ok = false;
          break;
        }
      }
      if (ok) {
        prefixEnd = i;
        break;
      }
    }
  }

  // ---- 对齐失败时的启发式降级 ----
  if (prefixEnd < 0) {
    // 含 music/音乐 关键字的段
    for (let i = 0; i < common; i++) {
      const lower = firstSegments[i].toLowerCase();
      if (lower.includes('music') || lower.includes('音乐')) {
        prefixEnd = i;
        break;
      }
    }
  }
  if (prefixEnd < 0 && common >= 2) {
    // 公共前缀 ≥2 段：末段很可能是歌手名，去掉
    prefixEnd = common - 2;
  }
  if (prefixEnd < 0) prefixEnd = -1; // 空前缀，裸相对路径 Artist/Album/file

  const prefixSegs = firstSegments.slice(0, prefixEnd + 1);
  // 保留范例的绝对路径开头标记（\ 或 / 开头）
  const startsAbsolute = /^[\\/]/.test(lines[0]);
  const prefix =
    prefixSegs.length > 0
      ? (startsAbsolute ? separator : '') + prefixSegs.join(separator) + separator
      : '';

  return { prefix, separator };
}
