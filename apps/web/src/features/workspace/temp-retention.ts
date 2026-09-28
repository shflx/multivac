import type { TempRetentionDays } from '@multivac/contracts';

/**
 * 会话临时目录生命周期的文案，与界面无关，便于单独测试。
 *
 * 规则（与服务端一致）：有文件的临时目录从归档时起按“设置 · 偏好”的保留时长（默认 30 天）保留，
 * 到期移到废纸篓；“从不”时一直保留。Multivac 工作目录与项目目录（托管或挂载）永不自动清理。
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
