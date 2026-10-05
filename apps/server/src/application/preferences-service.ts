import {
  DEFAULT_PREFERENCES,
  DEFAULT_RECENT_DAYS,
  DEFAULT_TASK_BUDGET,
  RECENT_DAY_OPTIONS,
  TaskBudgetMillisSchema,
  TempRetentionDaysSchema,
  type Preferences,
  type TaskBudget,
  type TempRetentionDays,
  type UpdatePreferences,
} from '@multivac/contracts';
import { Check } from 'typebox/value';

/** 偏好的持久化：按键保存 JSON 值。 */
export interface PreferenceRepository {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  /** 删除全部偏好（回到默认值），仅供 Fake E2E 在用例之间恢复初始状态。 */
  clearForTest(): void;
}

const TEMP_RETENTION_KEY = 'tempRetentionDays';
const TASK_BUDGET_MILLIS_KEY = 'taskBudgetMillis';

/**
 * 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端，改完即生效。
 * 存储中缺失或无法识别的值按默认值处理（临时目录保留 30 天，任务执行时长 6 小时）。
 */
export class PreferencesService {
  private readonly listeners = new Set<(preferences: Preferences) => void>();

  constructor(private readonly repository: PreferenceRepository) {}

  get(): Preferences {
    const days = this.repository.get('recentDays');
    return { tempRetentionDays: this.tempRetentionDays(), recentDays: RECENT_DAY_OPTIONS.find((value) => value === days) ?? DEFAULT_RECENT_DAYS,
      taskBudgetMillis: this.taskBudgetMillis() };
  }

  tempRetentionDays(): TempRetentionDays {
    const stored = this.repository.get(TEMP_RETENTION_KEY);
    return Check(TempRetentionDaysSchema, stored) ? stored : DEFAULT_PREFERENCES.tempRetentionDays;
  }

  /** 新建任务使用的任务树共享执行时长上限。 */
  taskBudgetMillis(): number {
    const stored = this.repository.get(TASK_BUDGET_MILLIS_KEY);
    return Check(TaskBudgetMillisSchema, stored) ? stored : DEFAULT_PREFERENCES.taskBudgetMillis!;
  }

  /**
   * 新建任务的默认预算：只有执行时长跟随偏好，运行次数与输出字节沿用固定默认值。
   * 已创建的任务保留创建时的预算，不因此改变。
   */
  defaultTaskBudget(): TaskBudget {
    return { ...DEFAULT_TASK_BUDGET, maxMillis: this.taskBudgetMillis() };
  }

  /** 只改给出的字段；保存后通知订阅者（如按新的保留时长补做一次到期检查）。 */
  update(patch: UpdatePreferences): Preferences {
    if (patch.tempRetentionDays !== undefined) this.repository.set(TEMP_RETENTION_KEY, patch.tempRetentionDays);
    if (patch.recentDays !== undefined) this.repository.set('recentDays', patch.recentDays);
    if (patch.taskBudgetMillis !== undefined) this.repository.set(TASK_BUDGET_MILLIS_KEY, patch.taskBudgetMillis);
    const preferences = this.get();
    for (const listener of this.listeners) listener(preferences);
    return preferences;
  }

  onChanged(listener: (preferences: Preferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resetForTest(): void {
    this.repository.clearForTest();
  }
}
