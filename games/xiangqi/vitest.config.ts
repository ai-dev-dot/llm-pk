import { defineConfig } from 'vitest/config';

// 引擎/服务端测试(node 环境)。前端(web/)有独立 package 与其 vitest 配置,
// 不在本配置承载;此处排除,避免根目录 npm test 误入 web 的 .vue 单测。
export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', 'web/**'],
  },
});