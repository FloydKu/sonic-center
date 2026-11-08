import { useCallback, useEffect, useState } from 'react';
import type { Song, ScanResult, ScanProgress, GetSongsOptions } from '@/shared/types';

/**
 * 音乐库调用示例 Hook：演示如何通过 window.api 扫描目录、订阅进度、查询歌曲。
 *
 * 用法：
 *   const { songs, loading, progress, scan, load } = useLibrary();
 *   <button onClick={() => scan()}>扫描音乐库</button>
 *
 * 注意：Song.bitrate 单位为 bps，展示时除以 1000 得到 kbps。
 */
export function useLibrary() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 查询库内歌曲 */
  const load = useCallback(async (opts?: GetSongsOptions) => {
    setLoading(true);
    setError(null);
    try {
      setSongs(await window.api.getSongs(opts));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** 扫描目录（不传 dir 则主进程弹文件夹选择框），完成后自动刷新列表 */
  const scan = useCallback(
    async (dir?: string): Promise<ScanResult | null> => {
      setLoading(true);
      setError(null);
      setProgress(null);
      const off = window.api.onScanProgress((p) => setProgress(p));
      try {
        const res = await window.api.scanDirectory(dir);
        await load();
        return res;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        off();
        setLoading(false);
      }
    },
    [load],
  );

  // 挂载时尝试加载已有歌曲
  useEffect(() => {
    load();
  }, [load]);

  return { songs, loading, progress, error, load, scan };
}
