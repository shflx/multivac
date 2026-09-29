import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProjectDirectoryKind } from '@multivac/contracts';
import { DIRECTORY_CHANGE_NOTE, PROJECT_DIRECTORY_KINDS } from './project-directories.js';

/**
 * 项目确认卡的共用内容（设计 5.5：对话创建与“新建项目…”共用同一张卡）：新建项目卡的标题、说明与“执行”一行，
 * 目录的类型、路径与规则，以及挂载、卸载目录时的说明。界面上的确认卡与对话中 Multivac 提出的确认卡都用这里，
 * 两条路径的内容一致。
 */

/** 新建项目卡的外壳文字（原型 ProjectCard）。 */
export const NEW_PROJECT_CARD = {
  title: '新建项目',
  description: '确认后自动带一个同名工作区',
  confirmLabel: '创建项目',
} as const;

/** “执行”一行：项目目录内的修改自动执行。 */
export const PROJECT_EXECUTION_NOTE = '这个目录内的修改将自动执行。';

/** 挂载目录的说明（设置 · 项目的挂载确认卡与对话中的挂载卡共用）。 */
export const MOUNT_DIRECTORY_NOTES: readonly string[] = [
  '挂载后排在已有目录之后，可以设为主目录；项目中新建的会话在主目录中工作。',
  DIRECTORY_CHANGE_NOTE,
];

/** 卸载目录的说明（设置 · 项目的卸载确认卡与对话中的卸载卡共用）。 */
export function unmountDirectoryNotes(primary: boolean): string[] {
  return [
    ...(primary ? ['它是主目录，卸载后由下一个目录成为主目录。'] : []),
    '目录本身和其中的文件不会被删除，之后可以重新挂载。',
    '已有会话继续使用创建时的工作目录。',
  ];
}

/** 设主目录的说明（对话中的设主目录卡）。 */
export const PRIMARY_DIRECTORY_NOTES: readonly string[] = [
  '项目中新建的会话在主目录中工作。',
  DIRECTORY_CHANGE_NOTE,
];

interface ProjectDirectoryRuleProps {
  kind: ProjectDirectoryKind;
  /** 将使用的路径；还不知道时为 null（显示 placeholder）。 */
  path: string | null;
  /** 正在向服务端核对。 */
  checking?: boolean;
  /** 路径还不知道时的说明。 */
  placeholder?: ReactNode;
  /** 需要读屏随核对结果播报时（可编辑的新建项目卡）。 */
  live?: boolean;
}

/** 目录的类型、路径与这类目录的规则（新建项目卡的“目录”一栏）。 */
export function ProjectDirectoryRule({ kind, path, checking = false, placeholder, live = false }: ProjectDirectoryRuleProps) {
  const rule = PROJECT_DIRECTORY_KINDS[kind];
  return (
    <span className="directory-rule" {...(live ? { 'aria-live': 'polite' as const } : {})} data-directory-kind={kind}>
      <span>
        <strong>{rule.label}</strong>
        {checking ? (
          <small className="directory-rule-checking">
            <LoaderCircle className="spin" aria-hidden="true" />
            正在核对目录
          </small>
        ) : path ? (
          <code>{path}</code>
        ) : (
          <small>{placeholder ?? '未能核对这个目录'}</small>
        )}
      </span>
      <small>{rule.rule}</small>
    </span>
  );
}
