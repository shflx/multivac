import { Type } from 'typebox';

/**
 * 管理中已实现的页面：发送时的当前视图、Multivac 打开管理页的工具与导航指令共用这一份。
 * 与界面的管理页注册表（web 的 MANAGEMENT_PAGES）一致；新增管理页时两处都要加。
 * 这里只依赖 typebox，其他契约模块都可以引用而不形成循环依赖。
 */

/** 管理中已实现的页面（与界面的管理页注册表一致）。 */
export const MANAGEMENT_PAGE_IDS = ['tasks', 'archive', 'projects', 'models', 'preferences', 'reading', 'conversations'] as const;
export const ManagementPageIdSchema = Type.Union([
  Type.Literal('archive'), Type.Literal('projects'), Type.Literal('models'), Type.Literal('preferences'),
  Type.Literal('tasks'),
  Type.Literal('reading'),
  Type.Literal('conversations'),
]);
export type ManagementPageIdValue = (typeof MANAGEMENT_PAGE_IDS)[number];

/** 管理页在对话与说明里的称呼。 */
export const MANAGEMENT_PAGE_LABELS: Readonly<Record<ManagementPageIdValue, string>> = {
  reading: '应用 · 读书',
  conversations: '工作 · 会话',
  tasks: '待办',
  archive: '设置 · 归档',
  projects: '设置 · 项目',
  models: '设置 · 模型',
  preferences: '设置 · 偏好',
};
