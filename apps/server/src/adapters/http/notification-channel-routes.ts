import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { SetNotificationChannelSchema, TestNotificationChannelSchema, ConfirmNotificationTestSchema, NotificationDeliveryQuerySchema, WechatVerifyCodeSchema } from '@multivac/contracts';
import QRCode from 'qrcode';
import type { NotificationChannelManagementService } from '../../application/notification-channel-management-service.js';
import { TaskServiceError } from '../../modules/tasks/task-error.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';
import { isRemoteRequest } from './remote-policy.js';

/** 即使单独装配handler也核对本机边界；不依赖前端隐藏按钮。 */
export function createNotificationChannelRequestHandler(service: NotificationChannelManagementService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/notification-channels' && !url.pathname.startsWith('/api/notification-channels/')) return false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    const address = request.socket.remoteAddress;
    if (isRemoteRequest(request) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address ?? '')) {
      send(403, { error: { code: 'ACCESS_DENIED', message: '通知渠道管理仅限本机。' } }); return true;
    }
    try {
      if (url.pathname === '/api/notification-channels' && request.method === 'GET') { send(200, service.list()); return true; }
      const operation = /^\/api\/notification-channels\/commands\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
      if (operation && request.method === 'GET') { send(200, service.operation(operation[1]!)); return true; }
      const route = /^\/api\/notification-channels\/([A-Za-z0-9._:-]{1,128})\/(deliveries|enabled|test|confirm-test|wechat(?:\/(?:qr|bind|unbind|verify))?)$/.exec(url.pathname);
      if (!route) { send(404, { error: { code: 'NOT_FOUND', message: '通知渠道接口不存在。' } }); return true; }
      const id = route[1]!, action = route[2]!;
      if (request.method === 'GET') {
        if (action === 'deliveries') {
          const query = Object.fromEntries([...url.searchParams].map(([key,value]) => [key, Number(value)]));
          if (!Check(NotificationDeliveryQuerySchema, query)) throw new SyntaxError();
          send(200, service.records(id, query.offset ?? 0, query.limit ?? 20));
        } else if (action === 'wechat') send(200, service.wechatStatus(id));
        else if (action === 'wechat/qr') {
          const content = service.qrContent(id);
          if (!content) { send(404, { error: { code: 'NOT_FOUND', message: '当前没有可用二维码。' } }); return true; }
          const image = await QRCode.toBuffer(content, { type: 'png', width: 256, margin: 2 });
          response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(image);
        } else send(405, { error: { code: 'INVALID_REQUEST', message: '不支持的请求方法。' } });
      } else if (request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { send(415, { error: { code: 'INVALID_REQUEST', message: '请使用 application/json。' } }); return true; }
        const input = await readJsonBody(request, 4096);
        if (action === 'enabled' && Check(SetNotificationChannelSchema, input)) send(200, service.setEnabled(id, input));
        else if (action === 'test' && Check(TestNotificationChannelSchema, input)) send(200, service.test(id, input));
        else if (action === 'confirm-test' && Check(ConfirmNotificationTestSchema, input)) send(200, service.confirm(id, input));
        else if (action === 'wechat/verify' && Check(WechatVerifyCodeSchema, input)) send(200, await service.manageWechat(id, 'verify', input));
        else if ((action === 'wechat/bind' || action === 'wechat/unbind') && Check(TestNotificationChannelSchema, input)) send(200, await service.manageWechat(id, action === 'wechat/bind' ? 'bind' : 'unbind', input));
        else throw new SyntaxError();
      } else send(405, { error: { code: 'INVALID_REQUEST', message: '不支持的请求方法。' } });
    } catch (error) {
      const status = error instanceof TaskServiceError ? error.code === 'NOT_FOUND' ? 404 : 409 : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
      send(status, { error: { code: error instanceof TaskServiceError ? error.code : 'INVALID_REQUEST', message: error instanceof TaskServiceError ? error.message : '通知渠道请求失败，请核对当前状态。' } });
    }
    return true;
  };
}
