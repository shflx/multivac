import type { CreateProject, Project, ProjectDirectoryKind, Workspace } from '@multivac/contracts';

/**
 * 项目目录的两种来源及其规则说明（文案按原型）：托管目录由 Multivac 创建并维护，挂载目录是用户已有的目录。
 * 两者在目录内的修改都自动执行。
 */
export const PROJECT_DIRECTORY_KINDS: Record<ProjectDirectoryKind, { label: string; rule: string }> = {
  managed: { label: '项目托管目录', rule: '由 Multivac 创建并托管，目录内的修改自动执行。' },
  mounted: { label: '挂载目录', rule: '你已有的目录，目录内的修改自动执行，目录外的修改需要确认。' },
};

/** 修改目录的影响：只作用于之后新建的会话。设置页与确认卡共用这句说明。 */
export const DIRECTORY_CHANGE_NOTE = '修改目录只影响之后新建的会话；已有会话继续使用创建时的工作目录。';

/** 工作区列表中的全部项目，按创建顺序。 */
export function projectsOf(workspaces: readonly Workspace[] | null): Project[] {
  return (workspaces ?? []).flatMap((workspace) => workspace.project ? [workspace.project] : []);
}

/** 新建项目的请求：名称与目录去掉首尾空白，目录为空表示创建托管目录。 */
export function createProjectInput(name: string, directory: string): CreateProject {
  const path = directory.trim();
  return { name: name.trim(), ...(path ? { directory: path } : {}) };
}

/**
 * 目录调整后要提交的全部路径（按顺序，第一个为主目录），交给更新接口整体替换：
 * - mount：新目录排在最后，不改变主目录；
 * - unmount：去掉该目录，卸载主目录时由下一个目录接替；
 * - primary：把该目录移到最前，其余顺序不变。
 */
export function directoryPaths(
  project: Project,
  change: { mount: string } | { unmount: string } | { primary: string },
): string[] {
  const paths = project.directories.map((directory) => directory.path);
  if ('mount' in change) return [...paths, change.mount.trim()];
  if ('unmount' in change) return paths.filter((path) => path !== change.unmount);
  return [change.primary, ...paths.filter((path) => path !== change.primary)];
}
