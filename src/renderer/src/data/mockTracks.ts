import type { Track } from '../types';

// 生成 1000 条模拟曲目，用于验证虚拟滚动表格性能
const ARTISTS = [
  '周杰伦',
  '林俊杰',
  '陈奕迅',
  '邓紫棋',
  '五月天',
  'Taylor Swift',
  'Adele',
  'Ed Sheeran',
  '李荣浩',
  '毛不易',
];
const ALBUMS = [
  '范特西',
  '第二天堂',
  'U87',
  '新的心跳',
  '自传',
  '1989',
  '25',
  '÷ (Divide)',
  '模特',
  '平凡的一天',
];
const TITLES = [
  '夜曲',
  '江南',
  '浮夸',
  '光年之外',
  '突然好想你',
  'Shake It Off',
  'Hello',
  'Perfect',
  '李白',
  '消愁',
  '晴天',
  '七里香',
  '稻香',
  '告白气球',
  '等你下课',
  '搁浅',
  '退后',
  '听妈妈的话',
  '本草纲目',
  '千里之外',
];
const BITRATES = [128, 192, 256, 320, 1411]; // 1411 = FLAC 无损

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

export const mockTracks: Track[] = Array.from({ length: 1000 }, (_, i) => {
  const artist = pick(ARTISTS, i);
  const album = pick(ALBUMS, i + 3);
  const baseTitle = pick(TITLES, i);
  const title =
    i >= TITLES.length ? `${baseTitle} (Remix ${Math.floor(i / TITLES.length)})` : baseTitle;
  return {
    id: i + 1,
    title,
    artist,
    album,
    duration: 180 + ((i * 7) % 180), // 3:00 ~ 6:00
    bitrate: BITRATES[i % BITRATES.length],
    filePath: `D:/Music/${artist}/${album}/${title}.mp3`,
  };
});
