import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 使用相对路径，构建产物可直接放在任意静态目录下预览。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': {target:'http://127.0.0.1:8787'} },
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
