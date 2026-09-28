import {
  DEFAULT_PREFERENCES,
  TempRetentionDaysSchema,
  type Preferences,
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

/**
 * 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端，改完即生效。
 * 存储中缺失或无法识别的值按默认值处理（临时目录保留 30 天）。
 */
export class PreferencesService {
  private readonly listeners = new Set<(preferences: Preferences) => void>();

  constructor(private readonly repository: PreferenceRepository) {}

  get(): Preferences {
    return { tempRetentionDays: this.tempRetentionDays() };
  }

  tempRetentionDays(): TempRetentionDays {
    const stored = this.repository.get(TEMP_RETENTION_KEY);
    return Check(TempRetentionDaysSchema, stored) ? stored : DEFAULT_PREFERENCES.tempRetentionDays;
  }

  /** 只改给出的字段；保存后通知订阅者（如按新的保留时长补做一次到期检查）。 */
  update(patch: UpdatePreferences): Preferences {
    if (patch.tempRetentionDays !== undefined) this.repository.set(TEMP_RETENTION_KEY, patch.tempRetentionDays);
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
