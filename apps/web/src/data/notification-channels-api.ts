import { NotificationChannelListSchema, NotificationChannelSchema, NotificationDeliverySchema, NotificationDeliveryPageSchema,
  NotificationChannelOperationSchema, WechatNotificationStatusSchema } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';
const base = '/api/notification-channels';
const post = (input: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
const path = (id: string, action: string) => `${base}/${encodeURIComponent(id)}/${action}`;
export const getNotificationChannels = () => fetchJson(base, undefined, NotificationChannelListSchema);
export const getNotificationRecords = (id: string, offset: number) => fetchJson(path(id, `deliveries?offset=${offset}&limit=20`), undefined, NotificationDeliveryPageSchema);
export const setNotificationEnabled = (id: string, input: { commandId: string; version: number; enabled: boolean }) => fetchJson(path(id, 'enabled'), post(input), NotificationChannelSchema);
export const sendNotificationTest = (id: string, input: { commandId: string; version: number }) => fetchJson(path(id, 'test'), post(input), NotificationDeliverySchema);
export const confirmNotificationTest = (id: string, input: { commandId: string; version: number; deliveryId: string; received: true }) => fetchJson(path(id, 'confirm-test'), post(input), NotificationChannelSchema);
export const getNotificationOperation = (id: string) => fetchJson(`${base}/commands/${encodeURIComponent(id)}`, undefined, NotificationChannelOperationSchema);
export const getWechatNotificationStatus = (id: string) => fetchJson(path(id, 'wechat'), undefined, WechatNotificationStatusSchema);
export const manageWechatNotifications = (id: string, action: 'bind' | 'unbind' | 'verify', input: { commandId: string; version: number; code?: string }) => fetchJson(path(id, `wechat/${action}`), post(input), NotificationChannelOperationSchema);
export const wechatQrImage = (id: string, version: number) => path(id, `wechat/qr?version=${version}`);
