/// <reference types="vite/client" />

// 构建模式判定：生产构建必须移除市长演示入口（补充指令 §7 / DECISIONS v1.1 #15）。
// 这里补充 vite 的环境类型，避免为了一个布尔值去改 tsconfig（团队规则 §4 禁止擅改 tsconfig）。
