import { noteFetch } from './note-access.js';
import { Check } from 'typebox/value';
import type { Static, TSchema } from 'typebox';
import { WINDOW_ID_HEADER } from '@multivac/contracts';
import { windowId } from './window-id.js';
import { notifyAccessFailure } from './access-api.js';

/** 各功能把协议层失败映射为自己的领域错误。 */
export interface JsonRequestErrors {
  /** 响应正文不是可解析的 JSON。 */
  unreadable(status: number): Error;
  /** 服务端返回失败状态；body 为已解析的错误正文。 */
  failed(body: unknown, status: number): Error;
  /** 成功响应不符合契约。 */
  invalid(status: number): Error;
}

/** 写请求（GET 以外）带上本窗口的 id：服务端据此在工作台变更事件中注明发起窗口。 */
function withWindowId(init: RequestInit | undefined): RequestInit | undefined {
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return init;
  const headers = new Headers(init?.headers);
  headers.set(WINDOW_ID_HEADER, windowId());
  return { ...init, headers };
}

/**
 * 发送请求并按 schema 校验 JSON 响应，返回类型由 schema 推导，编译期与运行时使用同一份约束。
 * 访问失效（登录过期等）统一通知；失败按 errors 映射为领域错误。
 */
export async function requestJson<S extends TSchema>(url: string, schema: S, init: RequestInit | undefined, errors: JsonRequestErrors): Promise<Static<S>> {
  const response = await noteFetch(url, withWindowId(init));
  notifyAccessFailure(response);
  let body: unknown;
  try { body = await response.json(); } catch { throw errors.unreadable(response.status); }
  if (!response.ok) throw errors.failed(body, response.status);
  if (!Check(schema, body)) throw errors.invalid(response.status);
  return body;
}
