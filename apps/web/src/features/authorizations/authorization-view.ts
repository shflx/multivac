import type { ToolAuthorizationGrant, ToolAuthorizationRequest } from '@multivac/contracts';
import {
  AUTHORIZATION_ACCESS_ACTIONS,
  AUTHORIZATION_OUTCOMES,
  AUTHORIZATION_TOOL_ACTIONS,
  approvalLabel,
  grantDirectoryLabel,
} from '../assistant/tool-authorizations.js';
import { truncateMiddle } from '../workspace/working-directory.js';

/**
 * 列表行里路径的最大字符数：超出时中间截断（保留开头的位置与结尾的目录名），完整路径放在悬停提示中。
 * 标题栏浮层很窄，栏位再窄时由样式在末尾省略。
 */
export const AUTHORIZATION_PATH_MAX_LENGTH = 40;

/** 记住的授权的范围写法（与授权卡上的按钮一致）。 */
export const GRANT_SCOPE_LABELS: Record<ToolAuthorizationGrant['scope'], string> = {
  session: '本会话内允许',
  project: '本项目内始终允许',
};

/** 授权列表里的时间：月/日 时:分（本地时间），与原型一致；无法解析时原样返回。 */
export function recordTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** 一行的主题：显示用的短写法（长路径中间截断）、完整写法（确认卡用）与悬停提示。 */
export interface RowSubject {
  text: string;
  full: string;
  title: string;
}

/** 记住的授权的主题：“修改或写入 /path/dir/”；悬停提示说明含其中的文件与子目录。 */
export function grantSubject(grant: ToolAuthorizationGrant): RowSubject {
  const action = AUTHORIZATION_ACCESS_ACTIONS[grant.access];
  const directory = grantDirectoryLabel(grant.directory);
  return {
    text: `${action} ${truncateMiddle(directory, AUTHORIZATION_PATH_MAX_LENGTH)}`,
    full: `${action} ${directory}`,
    title: `${action} ${directory} 中的文件（含子目录）`,
  };
}

/**
 * 记住的授权的说明行（按原型“类别 · 范围 · 记住于 …”）：目前记住的都是目录；
 * 另附最近一次使用与次数（原型没有，便于判断还要不要这条授权）。
 */
export function grantMetaText(grant: ToolAuthorizationGrant): string {
  const usage = grant.lastUsedAt ? `最近使用 ${recordTime(grant.lastUsedAt)}（共 ${grant.useCount} 次）` : '还没有用过';
  return `目录 · ${GRANT_SCOPE_LABELS[grant.scope]} · 记住于 ${recordTime(grant.createdAt)} · ${usage}`;
}

/** 授权请求的主题：操作与目标路径（长路径中间截断）。 */
export function requestSubject(request: ToolAuthorizationRequest): RowSubject {
  const action = AUTHORIZATION_TOOL_ACTIONS[request.toolName];
  const full = `${action} ${request.targetPath}`;
  return { text: `${action} ${truncateMiddle(request.targetPath, AUTHORIZATION_PATH_MAX_LENGTH)}`, full, title: full };
}

/** 授权请求的结果：待授权、批准依据（范围与来源）或未获批准的原因。 */
export function requestOutcomeText(request: ToolAuthorizationRequest): string {
  if (request.status === 'pending') return '待授权';
  if (request.status === 'approved') {
    return approvalLabel(request.approval ?? { scope: 'once', source: 'user', grantId: null });
  }
  return AUTHORIZATION_OUTCOMES[request.status].short;
}
