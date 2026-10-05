import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RECENT_DAY_OPTIONS, DEFAULT_RECENT_DAYS, DEFAULT_TASK_BUDGET_MILLIS, type TempDirectoryUsage, type TempRetentionDays, type TaskBudgetMillis } from '@multivac/contracts';
import { usePreferences } from './use-preferences.js';
import { SavedMark, useSavedFlash } from '../../components/saved-mark.js';
import { SettingsCard, SettingsRow } from '../../components/settings-card.js';
import { getPreferences, getTempDirectoryUsage, updatePreferences } from '../../data/preferences-api.js';
import {
  formatBytes,
  retentionFromOption,
  retentionOptionValue,
  TEMP_RETENTION_CHOICES,
} from '../workspace/temp-retention.js';
import { TASK_BUDGET_MILLIS_CHOICES, taskBudgetHint, taskBudgetMillisFromOption } from '../tasks/task-budget.js';

interface PreferencesPageProps {
  /** 页面可见；每次变为可见时重新读取偏好与临时目录占用。 */
  active: boolean;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 管理 · 设置 · 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端。
 *
 * 按原型是“会话与临时目录”与“任务执行”两张卡片，内部是“左说明右控件”的行：临时目录的保留时长
 * （7 / 30 / 90 天 / 从不）与任务树共享的执行时长（默认 6 小时），选择后立即保存并生效，
 * 控件旁短暂显示“已保存”，失败时原因写在行下；另显示临时目录的总占用（服务端统计，只显示、不提醒）。
 */
export function PreferencesPage({ active }: PreferencesPageProps) {
  const { preferences, setPreferences } = usePreferences();
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [recentSaveError, setRecentSaveError] = useState('');
  const [budgetSaveError, setBudgetSaveError] = useState('');
  const saved = useSavedFlash<'retention' | 'recent' | 'budget'>();
  const [usage, setUsage] = useState<TempDirectoryUsage | null>(null);
  const [usageState, setUsageState] = useState<'idle' | 'measuring' | 'error'>('idle');
  const usageRequest = useRef(0);
  const retentionLabelId = useId();
  const retentionHintId = useId();
  const retentionErrorId = useId();
  const budgetLabelId = useId();
  const budgetHintId = useId();
  const budgetErrorId = useId();

  /** 统计临时目录占用；只采用最近一次请求的结果。 */
  const measure = useCallback(async () => {
    const request = ++usageRequest.current;
    setUsageState('measuring');
    try {
      const measured = await getTempDirectoryUsage();
      if (request !== usageRequest.current) return;
      setUsage(measured);
      setUsageState('idle');
    } catch {
      if (request === usageRequest.current) setUsageState('error');
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError('');
    setSaveError('');
    setRecentSaveError('');
    setBudgetSaveError('');
    void measure();
    try {
      setPreferences(await getPreferences());
    } catch (error) {
      setLoadError(errorText(error, '偏好读取失败。'));
    }
  }, [measure]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  async function changeRetention(days: TempRetentionDays): Promise<void> {
    setSaving(true);
    setSaveError('');
    try {
      setPreferences(await updatePreferences({ tempRetentionDays: days }));
      saved.flash('retention');
      // 缩短时长可能随即清理了一些目录，占用随之变化。
      void measure();
    } catch (error) {
      // 下拉框仍显示已保存的值；原因写在这一行下方。
      setSaveError(errorText(error, '偏好保存失败，请重试。'));
    } finally {
      setSaving(false);
    }
  }

  async function changeBudget(millis: TaskBudgetMillis): Promise<void> {
    setSaving(true);
    setBudgetSaveError('');
    try {
      setPreferences(await updatePreferences({ taskBudgetMillis: millis }));
      saved.flash('budget');
    } catch (error) {
      // 下拉框仍显示已保存的值；原因写在这一行下方。
      setBudgetSaveError(errorText(error, '偏好保存失败，请重试。'));
    } finally {
      setSaving(false);
    }
  }

  if (preferences === null) {
    return (
      <div className="management-page-state" data-management-page="preferences" aria-live="polite">
        {loadError ? (
          <>
            <AlertCircle aria-hidden="true" />
            <h2>偏好读取失败</h2>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>正在读取偏好</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="preferences-page" data-management-page="preferences">
      <SettingsCard
        title="会话与临时目录"
        description={'对所有项目与默认工作区生效。会话未归档时临时目录不清理，归档时空的临时目录直接删除；'
          + '归入项目后留在原处的临时目录从归入时起同样计时。Multivac 工作目录与项目目录（托管或挂载）永不自动清理。'}
      >
        <SettingsRow label="最近会话" hint="按最后工作活动跨项目汇总未归档会话。" error={recentSaveError}>
          <SavedMark saved={saved} target="recent" />
          <select aria-label="最近会话" value={preferences.recentDays ?? DEFAULT_RECENT_DAYS} disabled={saving} onChange={async (event) => {
            setSaving(true); setRecentSaveError('');
            try { setPreferences(await updatePreferences({ recentDays: Number(event.target.value) as 0 | 1 | 3 | 7 | 14 })); saved.flash('recent'); }
            catch (cause) { setRecentSaveError(errorText(cause, '偏好保存失败，请重试。')); }
            finally { setSaving(false); }
          }}>
            {RECENT_DAY_OPTIONS.map((days) => <option key={days} value={days}>{days ? `${days} 天` : '不显示'}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow
          label="临时目录清理"
          labelId={retentionLabelId}
          hint={'不属于项目的会话归档后，临时目录里的文件保留多久，到期移到废纸篓（可以找回）；到期前恢复会话则取消。'
            + '修改后按归档时间重新计算，已超过新时长的随即移到废纸篓。'}
          hintId={retentionHintId}
          error={saveError}
          errorId={retentionErrorId}
        >
          <SavedMark saved={saved} target="retention" />
          <select
            aria-labelledby={retentionLabelId}
            aria-describedby={saveError ? `${retentionHintId} ${retentionErrorId}` : retentionHintId}
            aria-invalid={saveError ? true : undefined}
            value={retentionOptionValue(preferences.tempRetentionDays)}
            disabled={saving}
            onChange={(event) => void changeRetention(retentionFromOption(event.target.value))}
          >
            {TEMP_RETENTION_CHOICES.map((choice) => (
              <option key={retentionOptionValue(choice.value)} value={retentionOptionValue(choice.value)}>
                {choice.label}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          label="临时目录占用"
          hint={usage
            ? `${usage.directories} 个临时目录，含归档后等待清理的。只显示，不提醒。`
            : '全部会话临时目录的总大小。只显示，不提醒。'}
        >
          <span className="preference-value" aria-live="polite">
            {usageState === 'measuring' && !usage ? (
              <>
                <LoaderCircle className="spin" aria-hidden="true" />
                正在统计
              </>
            ) : usageState === 'error' && !usage ? '统计失败' : usage ? (
              <strong>
                {formatBytes(usage.bytes)}{usage.truncated ? ' 以上' : ''}
              </strong>
            ) : null}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="重新统计临时目录占用"
            title="重新统计"
            disabled={usageState === 'measuring'}
            onClick={() => void measure()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </SettingsRow>
      </SettingsCard>
      <SettingsCard
        title="任务执行"
        description={'任务执行使用独立目录，并在“设置 · 偏好”给出的共享预算内运行；预算耗尽时任务暂停并说明原因。'
          + '这里只调整执行时长，任务树共享的运行次数与输出字节沿用固定上限。'}
      >
        <SettingsRow label="执行时长上限" labelId={budgetLabelId} hint={taskBudgetHint()} hintId={budgetHintId} error={budgetSaveError} errorId={budgetErrorId}>
          <SavedMark saved={saved} target="budget" />
          <select aria-labelledby={budgetLabelId}
            aria-describedby={budgetSaveError ? `${budgetHintId} ${budgetErrorId}` : budgetHintId}
            aria-invalid={budgetSaveError ? true : undefined}
            value={preferences.taskBudgetMillis ?? DEFAULT_TASK_BUDGET_MILLIS} disabled={saving}
            onChange={(event) => void changeBudget(taskBudgetMillisFromOption(event.target.value))}>
            {TASK_BUDGET_MILLIS_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </select>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
