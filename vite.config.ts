import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    // 只统计当前项目的测试；artifacts 下的旧版本备份（如 v1-baseline）不计入本次结果。
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'release/**', 'artifacts/**'],
    // v0.8：真实 36 个月序列 + 完整月结路径的验收用例在单 worker 下约 6s；
    // 统一放宽到 30s，避免把“跑得慢”误报成断言失败（本地实测均 < 10s）。
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
