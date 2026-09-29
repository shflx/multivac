import type { IncomingMessage } from 'node:http';
import { WINDOW_ID_HEADER, WindowIdSchema, type WorkbenchChangeOrigin } from '@multivac/contracts';
import { Check } from 'typebox/value';

/**
 * 写请求的发起窗口（请求头 `x-multivac-window-id`）。窗口 id 只用来在变更事件中注明来源、
 * 让发起窗口识别自己的改动，不参与任何权限判断；缺失或不合法时按没有窗口身份处理。
 */
export function requestWindowId(request: IncomingMessage): string | null {
  const value = request.headers[WINDOW_ID_HEADER];
  const windowId = Array.isArray(value) ? value[0] : value;
  return Check(WindowIdSchema, windowId) ? windowId : null;
}

/** 界面直接发起的请求的变更来源：发起窗口，不在 Multivac 的一轮之中。 */
export function requestOrigin(request: IncomingMessage): WorkbenchChangeOrigin {
  return { windowId: requestWindowId(request), commandId: null };
}
