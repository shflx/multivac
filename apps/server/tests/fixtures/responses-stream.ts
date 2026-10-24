import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 从 coding-agent 的真实依赖位置解析，避免测试到另一份 pi-ai。
const root = dirname(findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@earendil-works/pi-coding-agent'))!);
export const responsesSDK = await import(pathToFileURL(join(root, 'dist/api/openai-responses.js')).href);
export const responsesShared = await import(pathToFileURL(join(root, 'dist/api/openai-responses-shared.js')).href);
export const controlledModel = { id: 'controlled', name: 'controlled', provider: 'openai', api: 'openai-responses',
  baseUrl: 'https://controlled.invalid/v1', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
export const usage = { input_tokens: 11, output_tokens: 5, total_tokens: 16,
  input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } };
export const textItem = { id: 'text', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: '完整输出🙂', annotations: [] }] };
export const toolItem = { id: 'tool', type: 'function_call', call_id: 'call', name: 'submit_task_result', arguments: '{"path":"result.md"}', status: 'completed' };
export const reasoningItem = { id: 'thinking', type: 'reasoning', summary: [{ type: 'summary_text', text: '受控思考' }] };
export function terminal(type = 'response.completed', extra: Record<string, unknown> = {}, output: unknown[] = [textItem]) {
  return { type, response: { id: 'controlled-response', status: type.slice('response.'.length), output, usage, ...extra } };
}
export function completedItems(items: unknown[] = [textItem]) {
  return items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }));
}

/** 内存流可保持连接打开；不会发出真实网络请求。取消可注入失败，检验停止事实。 */
export function controlledFetch(events: unknown[], options: { eof?: boolean; cancelError?: Error; cancelWait?: Promise<void>; fragmented?: boolean; onCancel?: () => void } = {}) {
  let cancels = 0, pulls = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const wire = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  const chunks = options.fragmented ? Array.from(wire, byte => Uint8Array.of(byte)) : [wire];
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(value) {
      pulls++;
      const chunk = chunks.shift();
      if (chunk) {
        value.enqueue(chunk);
        if (options.eof && chunks.length === 0) value.close();
      } else if (options.eof) value.close();
    },
    cancel() { cancels++; options.onCancel?.(); if (options.cancelError) throw options.cancelError; return options.cancelWait; },
  }, { highWaterMark: 0 });
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    init?.signal?.addEventListener('abort', () => {
      try { controller.error(new DOMException('Request aborted', 'AbortError')); } catch { /* 已收敛的流保持原终态。 */ }
    }, { once: true });
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'controlled-request' } });
  };
  return { fetch, body, cancels: () => cancels, pulls: () => pulls, close: () => controller.close() };
}
