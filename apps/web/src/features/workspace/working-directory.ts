import type { WorkingDirectoryKind } from '@multivac/contracts';

/**
 * 会话工作目录的类型与目录内的规则：会话标题栏、授权卡、会话页与工作区切换菜单共用。
 *
 * 规则只描述已经生效的行为：目录内的读写与命令自动执行；目录外的文件访问需要确认；
 * 临时目录归档后按偏好保留、到期移到废纸篓，其他类型的目录永不自动清理。
 * 保留天数随偏好变化，这里只写默认值与去处（“设置 · 偏好”），不写死当前设置。
 * worktree 为预留类型，目前不会出现。
 */
export const WORKING_DIRECTORY_KINDS: Record<WorkingDirectoryKind, { label: string; rule: string }> = {
  'session-temp': {
    label: '临时目录',
    rule: '会话专用，目录内的读写与命令自动执行。会话归档后，有文件的按“设置 · 偏好”保留（默认 30 天）再移到废纸篓，空目录直接删除。',
  },
  multivac: { label: 'Multivac 工作目录', rule: '全局 Multivac 长期使用，不会自动清理，目录内的读写与命令自动执行。' },
  'project-managed': { label: '项目托管目录', rule: '由 Multivac 托管，长期保留、不会自动清理，目录内的读写与命令自动执行。' },
  'project-mounted': { label: '挂载目录', rule: '你已有的目录，Multivac 不会清理它，目录内的读写与命令自动执行。' },
  worktree: { label: 'worktree', rule: '独立的 worktree，目录内的读写与命令自动执行。' },
};

/** 目录外的规则：与目录边界的判定一致，只有读取、修改、写入文件由程序拦截并请你确认。 */
export const OUTSIDE_WORKING_DIRECTORY_RULE = '读取、修改或写入目录外的文件需要你确认。';

/** 一类目录的完整规则：目录内怎么执行、会不会被清理，目录外需要确认。 */
export function workingDirectoryRule(kind: WorkingDirectoryKind): string {
  return `${WORKING_DIRECTORY_KINDS[kind].rule}${OUTSIDE_WORKING_DIRECTORY_RULE}`;
}

/** 目录名：路径的最后一段（忽略结尾的分隔符）；根目录原样返回。 */
export function workingDirectoryName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

/** 标题栏中目录名的最大字符数：临时目录名形如“日期-会话名-短 id”，超出时保留首尾。 */
export const DIRECTORY_NAME_MAX_LENGTH = 28;

/**
 * 中间截断：超过 max 个字符时保留开头与结尾，中间以“…”代替（结果恰为 max 个字符）。
 * 按码点计数，不会把代理对拆开；开头多保留一个字符。
 */
export function truncateMiddle(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  if (max <= 1) return '…';
  const kept = max - 1;
  const head = Math.ceil(kept / 2);
  const tail = kept - head;
  return `${characters.slice(0, head).join('')}…${tail > 0 ? characters.slice(-tail).join('') : ''}`;
}
