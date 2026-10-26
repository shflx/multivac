import { PROJECT_FILE_SCOPE_NOTE, PROJECT_CWD_CHANGE_NOTE } from '@multivac/contracts';
import type { CreateProject, Project, ProjectDirectoryKind, Workspace } from '@multivac/contracts';

/**
 * 项目目录的两种来源及其规则说明（文案按原型）：托管目录由 Multivac 创建并维护，挂载目录是用户已有的目录。
 * 两者在目录内的修改都自动执行。
 */
export const PROJECT_DIRECTORY_KINDS: Record<ProjectDirectoryKind, { label: string; rule: string }> = {
  managed: { label: '项目托管目录', rule: '由 Multivac 创建并托管，普通项目工作会话可直接读取、编辑和写入。' },
  mounted: { label: '挂载目录', rule: '你已有的目录，普通项目工作会话可直接读取、编辑和写入；项目范围外无其他授权的访问仍需确认。' },
};

/** 访问范围随当前记录生效，默认 cwd 的变更只作用于新会话。 */
export const DIRECTORY_CHANGE_NOTE = `${PROJECT_FILE_SCOPE_NOTE}${PROJECT_CWD_CHANGE_NOTE}`;

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

/**
 * 列表等窄处展示的简写路径：用户主目录（macOS 的 /Users/名字、Linux 的 /home/名字）写成 ~。
 * 只用于展示，完整路径仍在目录卡片中给出。
 */
export function displayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, '~');
}

/** 路径的最后一级目录名，用于不必重复完整路径的地方。 */
export function directoryName(path: string): string {
  return comparablePath(path).split('/').filter(Boolean).at(-1) ?? '/';
}

/** 比较路径时忽略首尾空白与末尾的斜杠（根目录本身除外）。 */
function comparablePath(path: string): string {
  return path.trim().replace(/\/+$/u, '') || '/';
}

/**
 * 挂载前在输入框下就地说明的问题（文案按原型）：空路径，或与项目中已有目录的字面路径相同。
 * 其余规则（绝对路径、存在、范围、跟随符号链接后重复等）仍由确认卡上的服务端校验说明。
 */
export function mountPathError(project: Project, path: string): string {
  if (!path.trim()) return '请输入要挂载的目录。';
  const target = comparablePath(path);
  if (project.directories.some((directory) => comparablePath(directory.path) === target)) return '这个目录已经在项目里了。';
  return '';
}
