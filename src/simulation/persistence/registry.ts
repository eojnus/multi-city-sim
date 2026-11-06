/**
 * v1.7 存档系统：模块注册表。
 *
 * 职责：
 * - 注册模块并拒绝重复 ID / 非法 ID / 重复的数据归属路径；
 * - 提供按 ID 查找、按注册顺序导出/恢复的稳定顺序；
 * - 校验“必需模块集合”是否存在（新格式存档缺必需模块 = 损坏；旧格式升级由迁移入口负责补）。
 *
 * 注册表不接触文件，也不直接调用模块的 export/restore——那是 saveCoordinator 的职责。
 */

import type { SaveModule, SaveModuleId } from './types';
import { SAVE_MODULE_ID_PATTERN } from './types';

export interface SaveModuleRegistryOptions {
  /** 注册顺序即导出/恢复顺序；默认要求 'world' 必须第一个注册（候选世界骨架由它建立）。 */
  requireWorldFirst?: boolean;
}

/**
 * 判断两个归属路径是否重叠。
 *
 * 路径按 `.` 分段、`[]` 表示数组元素。重叠定义：
 * - 完全相同；
 * - 一方是另一方的祖先（`cities` 与 `cities[].population` 重叠）；
 * - 数组标记差异不影响相等判断（`cities[].population` 与 `cities[].population[]` 视为重叠，
 *   因为后者是前者的子结构）。
 */
export function savePathsOverlap(a: string, b: string): boolean {
  const normalize = (path: string): string[] =>
    path
      .split('.')
      .map((segment) => segment.replace(/\[\]$/g, ''))
      .filter((segment) => segment.length > 0);
  const left = normalize(a);
  const right = normalize(b);
  if (left.length === 0 || right.length === 0) return true;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class SaveModuleRegistry {
  private readonly modules = new Map<string, SaveModule>();
  private readonly order: string[] = [];
  private readonly worldFirst: boolean;

  constructor(options: SaveModuleRegistryOptions = {}) {
    this.worldFirst = options.requireWorldFirst ?? true;
  }

  /**
   * 注册模块。失败时抛错（调用方是代码级注册，不是用户输入；应在启动/测试时立即暴露）。
   */
  register(module: SaveModule): this {
    const id = module.id;
    if (typeof id !== 'string' || !SAVE_MODULE_ID_PATTERN.test(id)) {
      throw new Error(`存档模块 ID 非法：${String(id)}（要求 ${SAVE_MODULE_ID_PATTERN}）`);
    }
    if (this.modules.has(id)) {
      throw new Error(`存档模块 ID 重复注册：${id}`);
    }
    if (!Number.isInteger(module.version) || module.version < 1) {
      throw new Error(`存档模块 ${id} 的 version 必须是 >=1 的整数`);
    }
    if (typeof module.required !== 'boolean') {
      throw new Error(`存档模块 ${id} 必须声明 required（boolean）`);
    }
    if (!Array.isArray(module.ownedPaths) || module.ownedPaths.length === 0) {
      throw new Error(`存档模块 ${id} 必须声明非空的 ownedPaths`);
    }
    for (const path of module.ownedPaths) {
      if (typeof path !== 'string' || path.trim() !== path || path.length === 0) {
        throw new Error(`存档模块 ${id} 的归属路径非法：${String(path)}`);
      }
      for (const other of this.modules.values()) {
        for (const otherPath of other.ownedPaths) {
          if (savePathsOverlap(path, otherPath)) {
            throw new Error(
              `存档模块数据归属重复：${id} 的 "${path}" 与 ${other.id} 的 "${otherPath}" 重叠`,
            );
          }
        }
      }
    }
    if (this.worldFirst && this.order.length === 0 && id !== 'world') {
      throw new Error(`存档模块注册顺序错误：'world' 必须最先注册（当前先注册了 ${id}）`);
    }
    for (const method of ['export', 'validate', 'migrate', 'restore'] as const) {
      if (typeof (module as unknown as Record<string, unknown>)[method] !== 'function') {
        throw new Error(`存档模块 ${id} 缺少方法 ${method}()`);
      }
    }
    this.modules.set(id, module);
    this.order.push(id);
    return this;
  }

  has(id: string): boolean {
    return this.modules.has(id);
  }

  get<T = unknown>(id: string): SaveModule<T> {
    const module = this.modules.get(id);
    if (!module) throw new Error(`未注册的存档模块：${id}`);
    return module as SaveModule<T>;
  }

  /** 按注册顺序返回全部模块（导出/恢复顺序）。 */
  list(): SaveModule[] {
    return this.order.map((id) => this.get(id));
  }

  /** 必需模块 ID 集合。 */
  requiredIds(): string[] {
    return this.list()
      .filter((module) => module.required)
      .map((module) => module.id);
  }
}

/** 模块 ID 联合类型与字符串的一致性检查（编译期约束之外的运行期断言）。 */
export function isKnownSaveModuleId(value: string): value is SaveModuleId {
  return typeof value === 'string' && SAVE_MODULE_ID_PATTERN.test(value);
}
