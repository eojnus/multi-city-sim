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
  },
});
