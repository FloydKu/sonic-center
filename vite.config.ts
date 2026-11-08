import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// 渲染进程使用 Vite 构建；主进程/preload 由 tsc (tsconfig.node.json) 编译
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
