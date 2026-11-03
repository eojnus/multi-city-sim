// 企业上下文各标签页的内容。
//
// renderCompanyDetail({ section }) 复用原有企业详情分区（只切割已渲染 HTML），
// 因此旧版完整详情与标签页看到的是同一份业务数据，不会出现两套口径。

import type { GameStore } from '../../app/gameStore';
import type { Company } from '../../simulation/contracts/types';
import { renderCompanyDetail } from '../panels';

const COMPANY_TAB_SECTIONS: Record<string, 'overview' | 'operation' | 'finance' | 'governance' | 'stocks'> = {
  overview: 'overview',
  operation: 'operation',
  finance: 'finance',
  governance: 'governance',
  stocks: 'stocks',
};

export interface CompanyTabOptions {
  /** 区域视图聚焦企业时显示关闭按钮；建筑内嵌企业详情不显示。 */
  showClose: boolean;
}

export function renderCompanyTabBody(
  store: GameStore,
  company: Company,
  tab: string,
  options: CompanyTabOptions,
): string {
  const section = COMPANY_TAB_SECTIONS[tab] ?? 'overview';
  return renderCompanyDetail(store, company, {
    section,
    showClose: options.showClose && section === 'overview',
    investTestId: false,
  });
}
