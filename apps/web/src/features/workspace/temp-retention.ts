import {
  DEFAULT_TEMP_RETENTION_DAYS,
  type SessionArchivePreview,
  type SessionRestoreResult,
  type TempRetentionDays,
} from '@multivac/contracts';
import { entryList } from './entry-list.js';

/**
 * 会话临时目录生命周期的文案，与界面无关，便于单独测试。
 *
 * 规则（与服务端一致）：
 * - 会话未归档时不清理；归档时临时目录为空则直接删除，有文件时归档确认卡提示一次；
 * - 有文件的临时目录从归档时起按“设置 · 偏好”的保留时长（默认 30 天）保留，到期移到废纸篓；
 *   到期前恢复会话则取消；已移到废纸篓的，恢复时重建空目录并说明；
 * - 归入项目后留在原处的临时目录从归入时起同样计时；
 * - Multivac 工作目录与项目目录（托管或挂载）永不自动清理。
 */

/** 偏好页“临时目录清理”的选项。 */
export const TEMP_RETENTION_CHOICES: ReadonlyArray<{ value: TempRetentionDays; label: string }> = [
  { value: 7, label: '归档 7 天后' },
  { value: 30, label: '归档 30 天后' },
  { value: 90, label: '归档 90 天后' },
  { value: null, label: '从不清理' },
];

/** 下拉框的取值：null（从不）以 'never' 表示。 */
export function retentionOptionValue(days: TempRetentionDays): string {
  return days === null ? 'never' : String(days);
}

export function retentionFromOption(value: string): TempRetentionDays {
  const days = Number(value);
  return days === 7 || days === 30 || days === 90 ? days : null;
}

/** 之后的去向：“保留 30 天后移到废纸篓”，从不清理时“一直保留（偏好为从不清理）”。 */
export function retentionOutcome(days: TempRetentionDays): string {
  return days === null ? '一直保留（偏好为从不清理）' : `保留 ${days} 天后移到废纸篓`;
}

/**
 * 归档确认卡中关于工作目录的说明（提示一次）：
 * - 临时目录里有文件：列出文件，写明保留多久、到期移到废纸篓、到期前恢复则取消；
 * - 临时目录为空：归档时一并删除；
 * - 项目目录、Multivac 工作目录：保留，不会被清理；
 * - 没能核对（请求失败）：写出通用规则。
 */
export function archiveDirectoryDetails(preview: SessionArchivePreview | null): string[] {
  if (!preview) {
    return [
      '对话历史会保留。',
      `临时目录里有文件时，归档后按偏好保留一段时间（默认 ${DEFAULT_TEMP_RETENTION_DAYS} 天）再移到废纸篓；空的临时目录归档时删除。`,
    ];
  }
  const files = preview.files;
  if (!files) return ['对话历史与工作目录都会保留，项目目录不会被清理。'];
  if (files.total === 0) return ['对话历史会保留；临时目录是空的，归档时一并删除。'];
  const days = preview.tempRetentionDays;
  return [
    `临时目录里还有文件：${entryList(files.names, files.total)}。`,
    days === null
      ? '归档后临时目录一直保留（偏好为从不清理）。'
      : `归档后临时目录保留 ${days} 天，到期移到废纸篓；到期前恢复会话则取消清理。`,
  ];
}

/** 恢复结果的说明：临时目录已到期移到废纸篓时写明时间与位置；否则为 null（不另作提示）。 */
export function restoreNoticeText(title: string, result: Pick<SessionRestoreResult, 'trashedDirectory'>): string | null {
  const trashed = result.trashedDirectory;
  if (!trashed) return null;
  return `已恢复「${title}」。它的临时目录已于 ${localDate(trashed.trashedAt)} 到期移到废纸篓（${trashed.trashPath}），`
    + '已重建空的临时目录；需要原来的文件，可以从废纸篓找回。';
}

/** 本地日期，如“2026/10/28”；无法解析时原样返回。 */
function localDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 占用的字节数：按 1024 进位，保留一位小数（整数时不带小数）。 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : String(Number(value.toFixed(1)));
  return `${text} ${units[unit]}`;
}
