import { Type } from 'typebox';

/**
 * 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端。
 *
 * 目前只有临时目录的保留时长：不属于项目的会话归档后，临时目录里的文件保留多少天再移到废纸篓；
 * null 表示从不自动清理。Multivac 工作目录与项目目录（托管或挂载）永不自动清理，不受它影响。
 */
export const TEMP_RETENTION_DAY_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_TEMP_RETENTION_DAYS = 30;
export const PREFERENCES_BODY_LIMIT_BYTES = 1024;

export const TempRetentionDaysSchema = Type.Union([
  Type.Literal(7),
  Type.Literal(30),
  Type.Literal(90),
  Type.Null(),
]);
/** 临时目录保留天数；null 为从不清理。 */
export type TempRetentionDays = Type.Static<typeof TempRetentionDaysSchema>;

export const PreferencesSchema = Type.Object(
  {
    /** 会话归档（或归入项目后留下的临时目录）之后，临时目录保留的天数；到期移到废纸篓。 */
    tempRetentionDays: TempRetentionDaysSchema,
    recentDays: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(3), Type.Literal(7), Type.Literal(14)])),
  },
  { additionalProperties: false },
);
export type Preferences = Type.Static<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = { tempRetentionDays: DEFAULT_TEMP_RETENTION_DAYS };

/** 更新偏好：只改给出的字段，至少给出一项。 */
export const UpdatePreferencesSchema = Type.Object(
  { tempRetentionDays: Type.Optional(TempRetentionDaysSchema), recentDays: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(3), Type.Literal(7), Type.Literal(14)])) },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdatePreferences = Type.Static<typeof UpdatePreferencesSchema>;

export const PreferencesResponseSchema = Type.Object(
  { preferences: PreferencesSchema },
  { additionalProperties: false },
);
export type PreferencesResponse = Type.Static<typeof PreferencesResponseSchema>;

/**
 * 临时目录的总占用（工作文件根目录下 `sessions/` 中的全部内容，含归档后等待清理的与归入项目后留下的）。
 * 由服务端遍历计算：不跟随符号链接，硬链接只计一次；条目过多时停止并标记为不完整。
 */
export const TempDirectoryUsageSchema = Type.Object(
  {
    /** `sessions/` 下第一层的临时目录数。 */
    directories: Type.Integer({ minimum: 0 }),
    /** 其中文件的字节数之和（符号链接只计链接本身）。 */
    bytes: Type.Integer({ minimum: 0 }),
    /** 条目超过遍历上限时为 true，此时数值只是已统计部分。 */
    truncated: Type.Boolean(),
    measuredAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type TempDirectoryUsage = Type.Static<typeof TempDirectoryUsageSchema>;
