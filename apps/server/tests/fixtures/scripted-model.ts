import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * 真实 Pi 集成测试使用的本机脚本化模型：按顺序回放 OpenAI Chat Completions 的 SSE 流，
 * 不需要真实模型凭据。Pi SDK、SessionManager、SettingsManager 与内置工具全部真实运行。
 */

export type ScriptedStep =
  | { toolCalls: Array<{ name: 'bash' | 'read' | 'write' | 'edit'; arguments: Record<string, unknown> }> }
  | { text: string };

/** 按顺序回放脚本的本机模型端点；记录每次请求中 Pi 回传的工具结果。 */
export async function startScriptedModel() {
  const steps: ScriptedStep[] = [];
  const toolResults: string[][] = [];
  let calls = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      // 只取本轮新增的工具结果：最后一条非 tool 消息之后的 tool 消息。
      const trailing: string[] = [];
      for (let index = body.messages.length - 1; index >= 0 && body.messages[index]!.role === 'tool'; index -= 1) {
        const content = body.messages[index]!.content;
        trailing.unshift(typeof content === 'string' ? content : JSON.stringify(content));
      }
      toolResults.push(trailing);
      const step = steps.shift();
      const id = `chatcmpl-local-${calls += 1}`;
      const chunk = (delta: unknown, finishReason: string | null = null) =>
        ({ id, object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, delta, finish_reason: finishReason }] });
      const frames = !step
        ? [chunk({ role: 'assistant', content: '脚本已用尽。' }), chunk({}, 'stop')]
        : 'text' in step
          ? [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop')]
          : [chunk({
              role: 'assistant',
              tool_calls: step.toolCalls.map((call, index) => ({
                index, id: `call-${calls}-${index}`, type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }), chunk({}, 'tool_calls')];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    script: (...next: ScriptedStep[]) => { steps.push(...next); },
    /** 最近一轮 prompt 中各次请求回传的工具结果，按请求顺序展开。 */
    takeToolResults: () => toolResults.splice(0).flat(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 在 Pi agentDir 中登记脚本化模型（provider `local-scripted`、模型 `scripted`）与本地测试凭据。 */
export async function configureScriptedModel(agentDir: string, endpoint: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: { 'local-scripted': { baseUrl: endpoint, api: 'openai-completions', models: [{ id: 'scripted' }] } },
  }));
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    'local-scripted': { type: 'api_key', key: 'local-test-only' },
  }), { mode: 0o600 });
}
