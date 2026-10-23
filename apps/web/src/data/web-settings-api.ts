import { WebSettingsSchema, type UpdateWebSettings } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';
export const getWebSettings = () => fetchJson('/api/web-settings', undefined, WebSettingsSchema);
export const saveWebSettings = (input: UpdateWebSettings) => fetchJson('/api/web-settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
}, WebSettingsSchema);
