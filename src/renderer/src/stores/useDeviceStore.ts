import { create } from 'zustand';
import type { MtpStorage } from '@/shared/types';

interface DeviceState {
  connected: boolean;
  deviceName: string;
  freeSpaceGB: number;
  totalSpaceGB: number;
  /** 各存储设备明细 */
  storages: MtpStorage[];
  /** 同步进度 0~1，-1 表示空闲 */
  syncProgress: number;

  connect: () => void;
  disconnect: () => void;
  setFreeSpace: (gb: number) => void;
  setSyncProgress: (p: number) => void;
  /** 从 MTP 设备列表更新真实状态（无设备时断开） */
  updateFromDevice: (info: {
    name: string;
    freeSpace: number;
    totalSpace: number;
    storages?: MtpStorage[];
  } | null) => void;
}

export const useDeviceStore = create<DeviceState>((set) => ({
  connected: false,
  deviceName: '',
  freeSpaceGB: 0,
  totalSpaceGB: 0,
  storages: [],
  syncProgress: -1,

  connect: () => set({ connected: true }),
  disconnect: () => set({ connected: false, deviceName: '', storages: [] }),
  setFreeSpace: (gb) => set({ freeSpaceGB: gb }),
  setSyncProgress: (p) => set({ syncProgress: p }),
  updateFromDevice: (info) =>
    info
      ? set({
          connected: true,
          deviceName: info.name,
          freeSpaceGB: Math.round((info.freeSpace / 1073741824) * 10) / 10,
          totalSpaceGB: Math.round((info.totalSpace / 1073741824) * 10) / 10,
          storages: info.storages ?? [],
        })
      : set({ connected: false, deviceName: '', freeSpaceGB: 0, totalSpaceGB: 0, storages: [] }),
}));
