/**
 * 执行器会话身份中性化之前的字段名（以 Pi 命名）与现名的对照。
 *
 * 数据库内的记录由迁移一次性改写；浏览器存储、数据目录中的 JSON 文件等无法统一迁移的旧数据，
 * 在读取时经 `withRuntimeIdentityKeys` 换成现名后再按契约校验。新代码不得写出旧字段名。
 */
export const LEGACY_RUNTIME_IDENTITY_KEYS: Readonly<Record<string, string>> = {
  piSessionId: 'runtimeSessionId',
  piSessionPath: 'runtimeSessionRef',
  piEntryId: 'runtimeEntryId',
  piTurnRef: 'runtimeTurnRef',
  sourcePiEntryId: 'sourceRuntimeEntryId',
  sourcePiSessionId: 'sourceRuntimeSessionId',
  userPiEntryId: 'userRuntimeEntryId',
  baselinePiEntryId: 'baselineRuntimeEntryId',
};

/** 递归把旧字段名换成现名；同一对象已有现名时保留现名的值。不认识的结构原样返回。 */
export function withRuntimeIdentityKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withRuntimeIdentityKeys);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const current = LEGACY_RUNTIME_IDENTITY_KEYS[key];
    if (current) {
      if (!(current in value)) result[current] = withRuntimeIdentityKeys(item);
    } else {
      result[key] = withRuntimeIdentityKeys(item);
    }
  }
  return result;
}
