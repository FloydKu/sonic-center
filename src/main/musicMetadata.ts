import * as mm from 'music-metadata';
import type { IAudioMetadata, IOptions } from 'music-metadata';

/** music-metadata 解析 API 形态（仅声明用到的 parseFile） */
export interface MusicMetadataApi {
  parseFile: (filePath: string, options?: IOptions) => Promise<IAudioMetadata>;
}

type MmModule = MusicMetadataApi & {
  /**
   * Electron 32（Node 20）不支持 require(ESM)，music-metadata 经 require 只暴露
   * 异步加载器 loadMusicMetadata()；Node 22+ 的 require(ESM) 则直接返回带 parseFile 的命名空间。
   */
  loadMusicMetadata?: () => Promise<MusicMetadataApi>;
};

let apiPromise: Promise<MusicMetadataApi> | null = null;

/**
 * 获取 music-metadata 的解析 API（parseFile）。
 * 兼容两种运行时形态，按需懒加载并缓存。
 */
export function getMusicMetadata(): Promise<MusicMetadataApi> {
  if (apiPromise) return apiPromise;
  const mod = mm as unknown as MmModule;
  if (typeof mod.parseFile === 'function') {
    // Node 22+ / 浏览器：命名空间直接可用
    apiPromise = Promise.resolve(mod);
  } else if (typeof mod.loadMusicMetadata === 'function') {
    // Electron (Node 20)：走异步加载器
    apiPromise = mod.loadMusicMetadata();
  } else {
    apiPromise = Promise.reject(
      new Error('music-metadata 不可用：未找到 parseFile 或 loadMusicMetadata'),
    );
  }
  return apiPromise;
}
