/**
 * 解析 AI 回复中的曲目清单。
 *
 * system prompt 约定 AI 在回复末尾输出「【曲目清单】」标记 + 每行一首
 * 「歌名 - 歌手」；模型不守约时退化为全文列表行扫描。
 */

export interface ParsedTrackRef {
  title: string;
  artist: string;
}

/** 支持的清单标记（主约定 + 常见变体，宁滥勿漏） */
const MARKERS = ['【曲目清单】', '【曲目列表】', '【推荐曲目】', '【推荐歌曲】'];
const MAX_TRACKS = 20;

/** 去掉 Markdown 修饰符号 */
function cleanSegment(s: string): string {
  return s.replace(/[#*_`~>|]/g, '').trim();
}

/** 解析单行为「歌名 - 歌手」；requireListItem 时仅接受序号/圆点列表行 */
function parseLine(raw: string, requireListItem: boolean): ParsedTrackRef | null {
  let line = raw.trim();
  if (!line || line.length > 120) return null;
  // 退化模式仅认列表行（序号/圆点开头），避免把说明文字误判为曲目
  if (requireListItem && !/^(?:\d+[.、)）]|[-*•·])\s*/.test(line)) return null;
  // 去行首序号/项目符号、去粗体标记
  line = line.replace(/^(?:[-*•·]|\d+[.、)）])\s*/, '').replace(/\*\*/g, '');
  const m = line.match(/^(.+?)\s*[-–—~]\s*(.+)$/);
  if (!m) return null;
  let title = cleanSegment(m[1]);
  let artist = cleanSegment(m[2]);
  // 歌手字段去掉括号内补充说明（年代/理由等）
  artist = artist.replace(/[（(].*$/, '').trim();
  // 歌名去掉包裹符号
  title = title.replace(/^[《「'"‘“]+/, '').replace(/[》」'"’”]+$/, '').trim();
  if (!title || !artist) return null;
  // 超长字段视为说明文字误判
  if (title.length > 60 || artist.length > 60) return null;
  return { title, artist };
}

/** 从 AI 回复中解析曲目清单；无标记时退化为全文列表行扫描 */
export function parseTrackList(content: string): ParsedTrackRef[] {
  const lines = content.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (MARKERS.some((mk) => lines[i].includes(mk))) {
      start = i + 1;
      break;
    }
  }
  // 退化模式（无标记）：全文扫描但只认列表行
  const scope = start >= 0 ? lines.slice(start) : lines;
  const requireListItem = start < 0;

  const out: ParsedTrackRef[] = [];
  for (const raw of scope) {
    const t = parseLine(raw, requireListItem);
    if (t) out.push(t);
    if (out.length >= MAX_TRACKS) break;
  }
  return out;
}
