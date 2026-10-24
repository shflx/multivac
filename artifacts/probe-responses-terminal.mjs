import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = dirname(findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@earendil-works/pi-coding-agent')));
const { stream } = await import(pathToFileURL(join(root, 'dist/api/openai-responses.js')));
let close, cancelled = false;
const body = new ReadableStream({ start(controller) {
  close = () => controller.close();
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: {
    id: 'controlled', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  } })}\n\n`));
}, cancel() { cancelled = true; } });
const model = { id: 'controlled', provider: 'openai', api: 'openai-responses', baseUrl: 'https://controlled.invalid/v1',
  name: 'controlled', input: ['text'], contextWindow: 128000, maxTokens: 4096, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const response = stream(model, { messages: [] }, { apiKey: 'controlled', fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
let settled = false;
const result = response.result().then(value => { settled = true; return value; });
await new Promise(resolve => setTimeout(resolve, 50));
console.log(JSON.stringify({ case: 'completed with connection held open', settled, cancelled }));
if (!cancelled) close();
const message = await result;
console.log(JSON.stringify({ afterEOF: !cancelled, stopReason: message.stopReason, error: message.errorMessage, usage: message.usage, cancelled }));
