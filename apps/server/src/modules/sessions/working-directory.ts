import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

/** 临时目录名中会话名部分的最大字符数；加上日期与短 id 后仍远低于文件名 255 字节的上限。 */
export const SESSION_DIRECTORY_TITLE_MAX_LENGTH = 40;
/** 会话名清理后为空时使用的名称。 */
export const SESSION_DIRECTORY_FALLBACK_TITLE = '会话';
const SHORT_ID_LENGTH = 8;

/**
 * 会话名转为目录名的一段：只保留字母（含中文）、数字、组合符号与 `.`、`_`、`-`，
 * 其余字符（路径分隔符、系统保留字符、控制字符、空白与标点）一律替换为 `-`；
 * 连续的 `-` 合并，首尾的 `-` 与 `.` 去掉，按字符截断到上限。
 * Agent 会在 bash 中引用这个路径，因此不保留空白与 shell 元字符。
 */
export function sessionDirectoryTitle(title: string): string {
  const tidy = (value: string) => value.replace(/-{2,}/gu, '-').replace(/^[-.]+|[-.]+$/gu, '');
  const cleaned = tidy(title.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-'));
  const clipped = tidy(Array.from(cleaned).slice(0, SESSION_DIRECTORY_TITLE_MAX_LENGTH).join(''));
  return clipped || SESSION_DIRECTORY_FALLBACK_TITLE;
}

/** 会话 id 的短形式：取前 8 位字母数字并转小写；id 中没有字母数字时取其摘要。 */
export function sessionDirectoryShortId(sessionId: string): string {
  const alphanumeric = sessionId.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
  return alphanumeric
    ? alphanumeric.slice(0, SHORT_ID_LENGTH)
    : createHash('sha256').update(sessionId).digest('hex').slice(0, SHORT_ID_LENGTH);
}

/** 时间点在服务所在时区的本地日期，形如 2026-09-28。 */
export function localDateStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 会话临时目录名：`<本地日期>-<会话名>-<短 id>`，日期取会话的创建时间。 */
export function sessionTempDirectoryName(input: { sessionId: string; title: string; createdAt: string }): string {
  return `${localDateStamp(new Date(input.createdAt))}-${sessionDirectoryTitle(input.title)}-${sessionDirectoryShortId(input.sessionId)}`;
}

/**
 * 在候选名中选出第一个未被占用的：`name`、`name-2`、`name-3`……
 * 占用判断由调用方给出（磁盘上已存在，或已被其他会话记录使用）。
 */
export function firstAvailableName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name}-${index}`;
    if (!taken(candidate)) return candidate;
  }
}

/** child 是否等于 parent 或位于 parent 之下；两者都应为已规范化的绝对路径。 */
export function isPathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
