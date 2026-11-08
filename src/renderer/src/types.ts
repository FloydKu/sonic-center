/** 曲目数据模型（兼容共享 Song 类型，Song 可直接赋值给 Track） */
export interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  /** 时长（秒） */
  duration: number;
  /** 比特率（kbps） */
  bitrate: number;
  filePath: string;
  /** 远程流直链（Audius 全曲 / iTunes 试听）；设置后播放直接走该 URL */
  sourceUrl?: string;
  /** 远程来源类型 */
  remoteKind?: 'audius' | 'preview';
  /** 远程曲目封面 */
  artworkUrl?: string;
  /** 以下字段由 Song（共享模型）携带，可选 */
  format?: string;
  fileSize?: number;
  mtime?: number;
  hasCover?: boolean;
}

/** 播放列表 */
export interface Playlist {
  id: string;
  name: string;
  trackCount: number;
}

/** 活动栏视图标识 */
export type ViewId = 'library' | 'playlists' | 'ai' | 'devices' | 'settings';

/** 主视图标签页 */
export interface Tab {
  id: string;
  title: string;
  icon?: string;
  closable: boolean;
}
