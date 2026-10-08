import { Activity, Inbox, Cpu, Folder, Archive, SlidersHorizontal, ListTodo, BookOpen, type LucideIcon } from 'lucide-react';

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

/**
 * 管理页的宽度类型（与原型一致）：
 * - `full`：铺满可用宽度，用于列表 + 详情这类需要横向空间的页面；
 * - `limited`：正文限宽（页头仍铺满），用于偏好这类“一行说明 + 一个控件”的简单规则页，避免行被拉得过长。
 */
export type ManagementPageWidth = 'full' | 'limited';

export interface ManagementPageDefinition {
  id: string;
  group: ManagementGroupId;
  /** 导航项、顶栏位置与页面标题共用的名称。 */
  label: string;
  icon: LucideIcon;
  /** 页面宽度：由页面在注册时声明，页面容器据此排版，见 ManagementPageWidth。 */
  width: ManagementPageWidth;
}

/**
 * 管理页注册表：只登记已实现的页面，未实现的页面不占位，也不显示为入口。
 * 同组页面按登记顺序排列。新增页面在这里加一项，再在 App 的页面内容表里给出对应内容。
 * 第一项是进入管理时默认打开的页面（之后回到上次所在的页面）。
 */
export const MANAGEMENT_PAGES = [
  { id: 'tasks', group: 'work', label: '待办', icon: ListTodo, width: 'full' },
  { id: 'runs', group: 'work', label: '运行', icon: Activity, width: 'full' },
  { id: 'inbox', group: 'work', label: 'Inbox', icon: Inbox, width: 'full' },
  { id: 'reading', group: 'apps', label: '读书', icon: BookOpen, width: 'full' },
  {
    id: 'archive',
    group: 'settings',
    label: '归档',
    icon: Archive,
    width: 'full',
  },
  {
    id: 'projects',
    group: 'settings',
    label: '项目',
    icon: Folder,
    width: 'full',
  },
  {
    id: 'models',
    group: 'settings',
    label: '模型',
    icon: Cpu,
    width: 'full',
  },
  {
    id: 'preferences',
    group: 'settings',
    label: '偏好',
    icon: SlidersHorizontal,
    width: 'limited',
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

/**
 * 面板跳转里“管理”的一句说明：列出工作组的页面，设置组合称“设置”，如“会话与设置”。
 * 由注册表派生，新增工作页后随之更新；应用组是停留的地方，不列入（与原型一致）。
 */
export function managementSummary(groups: readonly ManagementNavGroup<ManagementPageDefinition>[]): string {
  const parts = groups.flatMap((group) => {
    if (group.id === 'work') return group.pages.map((page) => page.label);
    return group.id === 'settings' ? [group.label] : [];
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join('、')}与${parts.at(-1)}` : parts.join('');
}

export function managementPage(id: ManagementPageId): ManagementPageEntry {
  // 注册表是 as const 常量，按 id 必然能找到。
  return MANAGEMENT_PAGES.find((page) => page.id === id)!;
}

/** 上次页面/历史入口来自旧版本时，迁移到归档；未知值使用当前默认页。 */
export function resolveManagementPage(id: unknown): ManagementPageId {
  if (id === 'sessions') return 'archive';
  if (id === 'conversations' || id === 'notes') return 'reading';
  return MANAGEMENT_PAGES.find((page) => page.id === id)?.id ?? MANAGEMENT_PAGES[0].id;
}
