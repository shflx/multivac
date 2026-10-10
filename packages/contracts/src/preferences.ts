import { Type } from 'typebox';

/**
 * 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端。
 *
 * 包含会话范围、临时目录保留时长、任务执行时长与执行诊断开关。会话归档后临时目录里的文件保留多少天再移到废纸篓（null 表示从不清理）；
 * 任务树共享的执行时长上限改完即生效，只作用于之后新建的任务，已创建的任务保留创建时的预算。
 * 执行诊断默认开启，修改即时生效，只改变观测，不改变模型和任务执行。
 * Multivac 工作目录与项目目录（托管或挂载）永不自动清理，不受它们影响。
 */
export const TEMP_RETENTION_DAY_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_TEMP_RETENTION_DAYS = 30;
export const PREFERENCES_BODY_LIMIT_BYTES = 1024;

/**
 * 任务树共享的执行时长：默认 6 小时，可在偏好里按档位调整。
 * 运行次数与输出字节沿用固定默认值，不随偏好变化。
 */
export const TASK_BUDGET_MILLIS_OPTIONS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
export const DEFAULT_TASK_BUDGET_MILLIS = 6 * 3_600_000;
export const TaskBudgetMillisSchema = Type.Union([
  Type.Literal(30 * 60_000), Type.Literal(2 * 3_600_000), Type.Literal(6 * 3_600_000), Type.Literal(24 * 3_600_000),
]);
export type TaskBudgetMillis = Type.Static<typeof TaskBudgetMillisSchema>;

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
    /** 新建任务的任务树共享执行时长上限；已创建的任务保留创建时的预算。 */
    taskBudgetMillis: Type.Optional(TaskBudgetMillisSchema),
    /** 全局执行诊断开关；缺失时沿用默认开启，修改后立即生效。 */
    executionDiagnosticsEnabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type Preferences = Type.Static<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = { tempRetentionDays: DEFAULT_TEMP_RETENTION_DAYS, taskBudgetMillis: DEFAULT_TASK_BUDGET_MILLIS, executionDiagnosticsEnabled: true };

/** 更新偏好：只改给出的字段，至少给出一项。 */
export const UpdatePreferencesSchema = Type.Object(
  {
    tempRetentionDays: Type.Optional(TempRetentionDaysSchema),
    recentDays: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(3), Type.Literal(7), Type.Literal(14)])),
    taskBudgetMillis: Type.Optional(TaskBudgetMillisSchema),
    executionDiagnosticsEnabled: Type.Optional(Type.Boolean()),
  },
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
