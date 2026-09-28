import { AlertCircle, LoaderCircle, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Preferences, TempDirectoryUsage, TempRetentionDays } from '@multivac/contracts';
import { getPreferences, getTempDirectoryUsage, updatePreferences } from '../../data/preferences-api.js';
import {
  formatBytes,
  retentionFromOption,
  retentionOptionValue,
  TEMP_RETENTION_CHOICES,
} from '../workspace/temp-retention.js';

interface PreferencesPageProps {
  /** 页面可见；每次变为可见时重新读取偏好与临时目录占用。 */
  active: boolean;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 保存后的说明：新时长按归档（或归入项目）时间重新计算，已超过的随即移到废纸篓。 */
function savedText(days: TempRetentionDays): string {
  return days === null
    ? '已保存：临时目录不再自动清理，已排期的也一直保留。'
    : `已保存：有文件的临时目录按归档时间重新计算，超过 ${days} 天的随即移到废纸篓。`;
}

/**
 * 管理 · 设置 · 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端。
 *
 * 目前只有临时目录的保留时长（7 / 30 / 90 天 / 从不），选择后立即保存并生效；
 * 另显示临时目录的总占用（服务端统计，只显示、不提醒）。
 */
export function PreferencesPage({ active }: PreferencesPageProps) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [usage, setUsage] = useState<TempDirectoryUsage | null>(null);
  const [usageState, setUsageState] = useState<'idle' | 'measuring' | 'error'>('idle');
  const usageRequest = useRef(0);
  const retentionLabelId = useId();
  const retentionHintId = useId();

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
    setStatus(null);
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
    setStatus(null);
    try {
      const saved = await updatePreferences({ tempRetentionDays: days });
      setPreferences(saved);
      setStatus({ tone: 'ok', text: savedText(saved.tempRetentionDays) });
      // 缩短时长可能随即清理了一些目录，占用随之变化。
      void measure();
    } catch (error) {
      setStatus({ tone: 'error', text: errorText(error, '偏好保存失败，请重试。') });
    } finally {
      setSaving(false);
    }
  }

  if (preferences === null) {
    return (
      <div className="sessions-page-state" data-management-page="preferences" aria-live="polite">
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
      <div className="preferences-note">
        <SlidersHorizontal aria-hidden="true" />
        <div>
          <strong>临时目录的全局规则</strong>
          <p>
            {'对默认工作区中不属于项目的会话生效：会话未归档时不清理；归档时空的临时目录直接删除。'
              + 'Multivac 工作目录与项目目录（托管或挂载）永不自动清理。'}
          </p>
        </div>
      </div>

      <ul className="preference-list">
        <li>
          <span>
            <strong id={retentionLabelId}>临时目录清理</strong>
            <small id={retentionHintId}>
              {'会话归档后，临时目录里的文件保留多久，到期移到废纸篓（可以找回）；到期前恢复会话则取消。'
                + '归入项目后留在原处的临时目录从归入时起同样计时。修改后按归档时间重新计算，已超过新时长的随即移到废纸篓。'}
            </small>
          </span>
          <select
            aria-labelledby={retentionLabelId}
            aria-describedby={retentionHintId}
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
        </li>
        <li>
          <span>
            <strong>临时目录占用</strong>
            <small>
              {usage
                ? `${usage.directories} 个临时目录，含归档后等待清理的。只显示，不提醒。`
                : '全部会话临时目录的总大小。只显示，不提醒。'}
            </small>
          </span>
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
          </span>
        </li>
      </ul>

      {status && (
        <p className={`preference-status ${status.tone}`} role={status.tone === 'error' ? 'alert' : 'status'}>
          {status.text}
        </p>
      )}
    </div>
  );
}
