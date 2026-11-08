import { getMusicMetadata } from './musicMetadata';
import NodeID3 from 'node-id3';
import * as fs from 'fs';
import * as path from 'path';
import type { TagUpdate } from '../shared/types';

export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  coverBase64?: string;
  coverMime?: string;
}

/** 读取音频文件的元数据标签（music-metadata，支持 mp3/flac/wav/m4a） */
export async function readTags(filePath: string): Promise<TrackTags> {
  const { parseFile } = await getMusicMetadata();
  const metadata = await parseFile(filePath);
  const picture = metadata.common.picture;

  return {
    title: metadata.common.title,
    artist: metadata.common.artist,
    album: metadata.common.album,
    genre: metadata.common.genre?.[0],
    year: metadata.common.year,
    trackNo: metadata.common.track.no ?? undefined,
    coverBase64: picture && picture.length > 0 ? Buffer.from(picture[0].data).toString('base64') : undefined,
    coverMime: picture && picture.length > 0 ? picture[0].format : undefined,
  };
}

/**
 * 写回标签（歌名 / 歌手 / 专辑 / 封面）到文件。
 * - MP3 / WAV：使用 node-id3 写 ID3v2（含 APIC 封面帧）
 * - FLAC：手写 Vorbis Comment / PICTURE 块重建 metadata 链
 * - M4A：暂不支持写入（读取仍可用 music-metadata），抛出明确错误
 *
 * @param update 仅传需要修改的字段；coverBase64 传 null 表示删除封面
 */
export async function writeTags(filePath: string, update: TagUpdate): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.mp3' || ext === '.wav') {
    writeId3(filePath, update);
    return;
  }

  if (ext === '.flac') {
    writeFlacTags(filePath, update);
    return;
  }

  throw new Error(
    `暂不支持写入 ${ext} 格式的标签（当前支持 MP3/WAV 的 ID3 与 FLAC 的 Vorbis Comment）。`,
  );
}

// ---------- FLAC Vorbis Comment 写入（零依赖手写实现） ----------

const FLAC_BLOCK_VORBIS_COMMENT = 4;
const FLAC_BLOCK_PICTURE = 6;

interface FlacBlock {
  type: number;
  data: Buffer;
}

/** 解析 FLAC 头部的 metadata 块链，返回各块与音频数据起始偏移 */
function parseFlacBlocks(buf: Buffer): { blocks: FlacBlock[]; audioOffset: number } {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'fLaC') {
    throw new Error('不是有效的 FLAC 文件');
  }
  const blocks: FlacBlock[] = [];
  let offset = 4;
  for (;;) {
    if (offset + 4 > buf.length) throw new Error('FLAC metadata 块头不完整');
    const type = buf[offset] & 0x7f;
    const isLast = (buf[offset] & 0x80) !== 0;
    const size = buf.readUIntBE(offset + 1, 3);
    offset += 4;
    if (offset + size > buf.length) throw new Error('FLAC metadata 块长度越界');
    blocks.push({ type, data: Buffer.from(buf.subarray(offset, offset + size)) });
    offset += size;
    if (isLast) break;
  }
  return { blocks, audioOffset: offset };
}

/** 序列化 metadata 块链（最后一个块自动打 last 标志） */
function serializeFlacBlocks(blocks: FlacBlock[]): Buffer {
  const parts: Buffer[] = [];
  blocks.forEach((b, i) => {
    const header = Buffer.alloc(4);
    header[0] = (i === blocks.length - 1 ? 0x80 : 0) | (b.type & 0x7f);
    header.writeUIntBE(b.data.length, 1, 3);
    parts.push(header, b.data);
  });
  return Buffer.concat(parts);
}

/** 解析 Vorbis Comment 块：返回 vendor 与注释键值对（key 统一大写） */
function parseVorbisComments(
  body: Buffer,
): { vendor: string; comments: { key: string; value: string }[] } {
  const comments: { key: string; value: string }[] = [];
  let offset = 0;
  if (offset + 4 > body.length) return { vendor: '', comments };
  const vendorLen = body.readUInt32LE(offset);
  offset += 4;
  if (offset + vendorLen > body.length) return { vendor: '', comments };
  const vendor = body.toString('utf8', offset, offset + vendorLen);
  offset += vendorLen;
  if (offset + 4 > body.length) return { vendor, comments };
  const count = body.readUInt32LE(offset);
  offset += 4;
  for (let i = 0; i < count && offset + 4 <= body.length; i++) {
    const len = body.readUInt32LE(offset);
    offset += 4;
    if (offset + len > body.length) break;
    const entry = body.toString('utf8', offset, offset + len);
    offset += len;
    const eq = entry.indexOf('=');
    if (eq > 0) comments.push({ key: entry.slice(0, eq).toUpperCase(), value: entry.slice(eq + 1) });
  }
  return { vendor, comments };
}

/** 构造 Vorbis Comment 块（全部 little-endian，字段格式 KEY=value） */
function buildVorbisCommentBody(vendor: string, comments: { key: string; value: string }[]): Buffer {
  const vendorBuf = Buffer.from(vendor, 'utf8');
  const parts: Buffer[] = [];
  const vendorLen = Buffer.alloc(4);
  vendorLen.writeUInt32LE(vendorBuf.length);
  parts.push(vendorLen, vendorBuf);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  parts.push(count);
  for (const c of comments) {
    const entry = Buffer.from(`${c.key}=${c.value}`, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(entry.length);
    parts.push(len, entry);
  }
  return Buffer.concat(parts);
}

/** 构造 PICTURE 块（全部 big-endian，可变长字段内联：type 3 = front cover） */
function buildPictureBody(mime: string, imageBuffer: Buffer): Buffer {
  const mimeBuf = Buffer.from(mime, 'utf8');
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
  };
  const parts: Buffer[] = [
    u32(3), // picture type: front cover
    u32(mimeBuf.length),
    mimeBuf,
    u32(0), // description 长度为 0
    u32(0), // width（需解码图片才能得到，多数播放器不校验，填 0）
    u32(0), // height
    u32(0), // color depth
    u32(0), // indexed color 数（非索引色填 0）
    u32(imageBuffer.length),
    imageBuffer,
  ];
  return Buffer.concat(parts);
}

/**
 * 写 FLAC 标签：重建 metadata 块链（Vorbis Comment / PICTURE），
 * 音频帧数据原样保留（STREAMINFO 的 MD5 仅校验音频数据，无需重算）。
 */
function writeFlacTags(filePath: string, update: TagUpdate): void {
  const buf = fs.readFileSync(filePath);
  const { blocks, audioOffset } = parseFlacBlocks(buf);

  // 分拣现有块：STREAMINFO / Vorbis Comment / PICTURE / 其他（原样保留）
  let streamInfo: FlacBlock | null = null;
  let oldVc: FlacBlock | null = null;
  const pictures: FlacBlock[] = [];
  const others: FlacBlock[] = [];
  for (const b of blocks) {
    if (b.type === 0 && !streamInfo) streamInfo = b;
    else if (b.type === FLAC_BLOCK_VORBIS_COMMENT) oldVc = b;
    else if (b.type === FLAC_BLOCK_PICTURE) pictures.push(b);
    else others.push(b);
  }
  if (!streamInfo) throw new Error('FLAC 缺少 STREAMINFO 块，文件可能已损坏');

  // 合并 Vorbis Comment：保留现有字段（如 TRACKNUMBER/DATE），覆盖传入项
  const parsed = oldVc ? parseVorbisComments(oldVc.data) : null;
  let comments = parsed?.comments ?? [];
  const overrides = [
    { key: 'TITLE', value: update.title },
    { key: 'ARTIST', value: update.artist },
    { key: 'ALBUM', value: update.album },
  ].filter((o) => o.value !== undefined);
  if (overrides.length > 0) {
    const touched = overrides.map((o) => o.key);
    comments = comments.filter((c) => !touched.includes(c.key));
    for (const o of overrides) {
      if (o.value !== '') comments.push({ key: o.key, value: o.value as string });
    }
  }

  // 封面：null 删除 / 有值替换 / undefined 保留原样
  let newPictures: FlacBlock[];
  if (update.coverBase64 === null) {
    newPictures = [];
  } else if (update.coverBase64 !== undefined) {
    newPictures = [
      {
        type: FLAC_BLOCK_PICTURE,
        data: buildPictureBody(
          update.coverMime ?? 'image/jpeg',
          Buffer.from(update.coverBase64, 'base64'),
        ),
      },
    ];
  } else {
    newPictures = pictures;
  }

  // 重组：fLaC magic + STREAMINFO + VC + PICTURE + 其他块 + 原音频数据
  const newBlocks: FlacBlock[] = [
    streamInfo,
    { type: FLAC_BLOCK_VORBIS_COMMENT, data: buildVorbisCommentBody(parsed?.vendor ?? '', comments) },
    ...newPictures,
    ...others,
  ];
  const out = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    serializeFlacBlocks(newBlocks),
    Buffer.from(buf.subarray(audioOffset)),
  ]);
  fs.writeFileSync(filePath, out);
}

/** 用 node-id3 更新 ID3 标签（保留未涉及的字段，仅覆盖传入项） */
function writeId3(filePath: string, update: TagUpdate): void {
  const tags: NodeID3.Tags = {};
  if (update.title !== undefined) tags.title = update.title;
  if (update.artist !== undefined) tags.artist = update.artist;
  if (update.album !== undefined) tags.album = update.album;

  if (update.coverBase64 === null) {
    // 删除封面：node-id3 没有直接「删除单帧」的 API，这里用 update 传空字符串触发清除
    tags.image = undefined;
  } else if (update.coverBase64 !== undefined) {
    tags.image = {
      description: '',
      mime: update.coverMime ?? 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      imageBuffer: Buffer.from(update.coverBase64, 'base64'),
    };
  }

  const ok = NodeID3.update(tags, filePath);
  if (ok !== true) {
    throw new Error('写入 ID3 标签失败');
  }
}
