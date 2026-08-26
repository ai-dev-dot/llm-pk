//
// Vite 前端配置:Vue 插件、dev 代理(/api 与 /ws → 后端 3010)、Vitest(jsdom + @vue/test-utils)。
//
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 后端默认端口(server/main.ts:PORT > config.json.port > 3010)
const BACKEND_PORT = 3010;

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});