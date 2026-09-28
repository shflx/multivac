import { Cpu, MessagesSquare, type LucideIcon } from 'lucide-react';

/**
 * 管理导航的分组：工作（定期过一遍的事务）、应用（可长时间停留的应用页）、设置（改完就不用再管的配置）。
 * 顺序即导航中的显示顺序；设置组在有其他分组时沉到底部。
 */
export const MANAGEMENT_GROUPS = [
  { id: 'work', label: '工作' },
  { id: 'apps', label: '应用' },
  { id: 'settings', label: '设置' },
] as const;

export type ManagementGroupId = (typeof MANAGEMENT_GROUPS)[number]['id'];

export interface ManagementPageDefinition {
  id: string;
  group: ManagementGroupId;
  /** 导航项、顶栏位置与页面标题共用的名称。 */
  label: string;
  icon: LucideIcon;
  /** 页面标题下的一句说明。 */
  description: string;
}

/**
 * 管理页注册表：只登记已实现的页面，未实现的页面不占位，也不显示为入口。
 * 同组页面按登记顺序排列。新增页面在这里加一项，再在 App 的页面内容表里给出对应内容。
 * 第一项是进入管理时默认打开的页面（之后回到上次所在的页面）。
 */
export const MANAGEMENT_PAGES = [
  {
    id: 'sessions',
    group: 'work',
    label: '会话',
    icon: MessagesSquare,
    description: '所有工作区的会话，含已归档的。在这里找回、改名、归档或恢复；要继续聊就在工作区打开。',
  },
  {
    id: 'models',
    group: 'settings',
    label: '模型',
    icon: Cpu,
    description: '管理模型配置、认证与连接状态，并设置全局默认模型。',
  },
] as const satisfies readonly ManagementPageDefinition[];

export type ManagementPageId = (typeof MANAGEMENT_PAGES)[number]['id'];
export type ManagementPageEntry = ManagementPageDefinition & { id: ManagementPageId };

export interface ManagementNavGroup<P extends ManagementPageDefinition> {
  id: ManagementGroupId;
  label: string;
  pages: P[];
}

/** 按分组整理导航；没有任何已实现页面的分组不出现，也就不显示分组标题。 */
export function managementNavGroups<P extends ManagementPageDefinition>(pages: readonly P[]): ManagementNavGroup<P>[] {
  return MANAGEMENT_GROUPS
    .map((group) => ({ id: group.id, label: group.label, pages: pages.filter((page) => page.group === group.id) }))
    .filter((group) => group.pages.length > 0);
}

/** 管理导航：由注册表派生，模块加载时整理一次。 */
export const MANAGEMENT_NAV = managementNavGroups<ManagementPageEntry>(MANAGEMENT_PAGES);

export function managementPage(id: ManagementPageId): ManagementPageEntry {
  // 注册表是 as const 常量，按 id 必然能找到。
  return MANAGEMENT_PAGES.find((page) => page.id === id)!;
}

export function managementGroupLabel(id: ManagementGroupId): string {
  return MANAGEMENT_GROUPS.find((group) => group.id === id)!.label;
}
