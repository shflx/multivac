import {
  PreferencesResponseSchema,
  TempDirectoryUsageSchema,
  type Preferences,
  type PreferencesResponse,
  type TempDirectoryUsage,
  type UpdatePreferences,
} from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

/** 偏好：对所有项目与默认工作区生效的全局规则，保存在服务端。 */
export async function getPreferences(): Promise<Preferences> {
  return (await fetchJson<PreferencesResponse>('/api/preferences', undefined, PreferencesResponseSchema)).preferences;
}

/** 只改给出的字段；保存后即按新规则生效。 */
export async function updatePreferences(input: UpdatePreferences): Promise<Preferences> {
  return (await fetchJson<PreferencesResponse>('/api/preferences', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, PreferencesResponseSchema)).preferences;
}

/** 临时目录的总占用（服务端遍历计算，不跟随符号链接）。 */
export function getTempDirectoryUsage(): Promise<TempDirectoryUsage> {
  return fetchJson('/api/temp-directories/usage', undefined, TempDirectoryUsageSchema);
}
