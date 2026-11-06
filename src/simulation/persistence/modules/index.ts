/**
 * v1.7 存档系统：默认模块注册表。
 *
 * 注册顺序 = 稳定的导出顺序；恢复顺序由协调器按 dependsOn 拓扑排序（world 最先）。
 * 新增系统时：在 persistence/types.ts 的 SaveModuleId 登记 ID、新建 modules/xxxSave.ts、
 * 在此注册并更新 docs/development/SAVE_SYSTEM_DESIGN.md 的归属表。
 */

import { SaveModuleRegistry } from '../registry';
import { bankingSaveModule } from './bankingSave';
import { bondsSaveModule } from './bondsSave';
import { companySaveModule } from './companySave';
import { equipmentSaveModule } from './equipmentSave';
import { governmentSaveModule } from './governmentSave';
import { managementSaveModule } from './managementSave';
import { marketTradeSaveModule } from './marketTradeSave';
import { politicsSaveModule } from './politicsSave';
import { populationSaveModule } from './populationSave';
import { securitiesSaveModule } from './securitiesSave';
import { worldSaveModule } from './worldSave';

/** 创建并返回包含全部内置模块的注册表（每次调用返回独立实例，避免测试间状态泄漏）。 */
export function createDefaultSaveRegistry(): SaveModuleRegistry {
  const registry = new SaveModuleRegistry();
  registry.register(worldSaveModule);
  registry.register(populationSaveModule);
  registry.register(companySaveModule);
  registry.register(marketTradeSaveModule);
  registry.register(equipmentSaveModule);
  registry.register(bankingSaveModule);
  registry.register(governmentSaveModule);
  registry.register(bondsSaveModule);
  registry.register(securitiesSaveModule);
  registry.register(managementSaveModule);
  registry.register(politicsSaveModule);
  return registry;
}

/** 内置模块 ID（与注册顺序一致；供测试与文档核对）。 */
export const DEFAULT_SAVE_MODULE_IDS = [
  'world',
  'population',
  'company',
  'marketTrade',
  'equipment',
  'banking',
  'government',
  'bonds',
  'securities',
  'management',
  'politics',
] as const;
