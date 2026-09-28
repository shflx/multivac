import { isAbsolute } from 'node:path';

export const DEFAULT_MULTIVAC_PORT = 4317;

export function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveServerPort(value: string | undefined): number {
  return Number.parseInt(optionalEnvironmentValue(value) ?? String(DEFAULT_MULTIVAC_PORT), 10);
}

/**
 * 授权等待时限（毫秒）；未设置时返回 undefined，使用默认的 30 分钟。
 * 必须是正整数，其他取值直接报错，避免误配置成立即过期或永不过期。
 */
export function resolveToolAuthorizationTimeoutMs(value: string | undefined): number | undefined {
  const normalized = optionalEnvironmentValue(value);
  if (normalized === undefined) return undefined;
  const timeoutMs = /^\d+$/u.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('MULTIVAC_TOOL_AUTHORIZATION_TIMEOUT_MS 必须是正整数（毫秒）。');
  }
  return timeoutMs;
}

/**
 * 到期的临时目录移入的废纸篓目录（`MULTIVAC_TRASH_DIR`）；未设置时使用系统废纸篓。
 * 测试与 E2E 用它指向临时目录，绝不触碰真实的废纸篓。必须是绝对路径。
 */
export function resolveTrashDirectory(value: string | undefined): string | undefined {
  const normalized = optionalEnvironmentValue(value);
  if (normalized === undefined) return undefined;
  if (!isAbsolute(normalized)) throw new Error(`MULTIVAC_TRASH_DIR 必须是绝对路径：${normalized}`);
  return normalized;
}
