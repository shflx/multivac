import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 固定到已核对的 SDK 源码；升级依赖时必须重新审查，不对未知版本做模糊替换。
const patches = [
  {
    file: 'api/openai-responses-shared.js',
    sha256: '00796997da00cd4cb77ae8c1c4bb92a3d4a4a4dd5bea18524de7173e4f877e4c',
    edits: [
      ['    let sawTerminalResponseEvent = false;', '    let sawTerminalResponseEvent = false;\n    const stopAtTerminal = model.api === "openai-responses";'],
      ['    const finalizeResponse = (response) => {', '    const finalizeResponse = (response, eventType) => {'],
      ['    for await (const event of openaiStream) {\n        await options?.onProviderStreamEvent?.(event, model);\n        if (event.type === "response.created") {', `    for await (const event of openaiStream) {
        const terminalStatus = { "response.completed": "completed", "response.incomplete": "incomplete", "response.failed": "failed", "response.cancelled": "cancelled" }[event.type];
        if (stopAtTerminal && terminalStatus && event.response?.status !== terminalStatus) {
            throw new Error("OpenAI Responses terminal event has an invalid status");
        }
        await options?.onProviderStreamEvent?.(event, model);
        if (event.type === "response.created") {`],
      ['            output.stopReason = "toolUse";\n        }\n    };', `            output.stopReason = "toolUse";
        }
        if (stopAtTerminal && status === "cancelled") output.errorMessage = "Response cancelled by provider";
        // 私有观测只接收枚举；观测异常不得改变协议终结。
        try { options?.onProtocolEvent?.({ type: eventType }); } catch {}
    };`],
      ['        else if (event.type === "response.completed" || event.type === "response.incomplete") {\n            finalizeResponse(event.response);', `        else if (event.type === "response.completed" || event.type === "response.incomplete" || (stopAtTerminal && event.type === "response.cancelled")) {
            finalizeResponse(event.response, event.type);
            // 协议终止不等待 EOF，但要等待正文取消完成。
            if (stopAtTerminal) {
                await options?.cancelResponseBody?.();
                break;
            }`],
      ['        else if (event.type === "error") {\n            throw new Error', '        else if (event.type === "error") {\n            try { options?.onProtocolEvent?.({ type: "error" }); } catch {}\n            throw new Error'],
      ['        else if (event.type === "response.failed") {\n            sawTerminalResponseEvent = true;\n            output.rawStopReason = event.response?.status;', `        else if (event.type === "response.failed") {
            if (stopAtTerminal) {
                finalizeResponse(event.response, event.type);
                await options?.cancelResponseBody?.();
            } else {
                sawTerminalResponseEvent = true;
                output.rawStopReason = event.response?.status;
            }`],
    ],
  },
  {
    file: 'api/openai-responses.js',
    sha256: 'c35b80b2eb7f84b0ea1d939784943038956aefec7b624ed7862ebe2fd9d40c4b',
    edits: [
      ['export const stream = (model, context, options) => {', `// OpenAI SDK 7 会先 abort，再忽略正文取消的结果。保留实际 reader 的取消承诺，供终态收尾核对。
function trackResponseBody(fetch) {
    let cancel;
    return {
        cancel: () => cancel?.(),
        fetch: async (input, init) => {
            const response = await fetch(input, init);
            return new Proxy(response, { get(target, key) {
                if (key === "body" && target.body) return new Proxy(target.body, { get(body, member) {
                    if (member === "getReader") return (...args) => {
                        const reader = body.getReader(...args);
                        let cancellation;
                        cancel = (reason) => cancellation ??= reader.cancel(reason);
                        return { read: () => reader.read(), cancel, releaseLock: () => reader.releaseLock() };
                    };
                    const value = Reflect.get(body, member, body);
                    return typeof value === "function" ? value.bind(body) : value;
                } });
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            } });
        },
    };
}
export const stream = (model, context, options) => {`],
      ['            const client = createClient(model, normalizedContext, apiKey, options?.headers, options?.identity, options?.fetch, cacheSessionId);', '            const responseBody = trackResponseBody(options?.fetch ?? globalThis.fetch);\n            const client = createClient(model, normalizedContext, apiKey, options?.headers, options?.identity, responseBody.fetch, cacheSessionId);'],
      ['                serviceTier: options?.serviceTier,\n                grammarToolInputProperties,', '                serviceTier: options?.serviceTier,\n                onProtocolEvent: options?.onProtocolEvent,\n                cancelResponseBody: responseBody.cancel,\n                grammarToolInputProperties,'],
    ],
  },
  {
    file: 'api/simple-options.js',
    sha256: '7e80e985f50d968dfd4422ed501d87280236470bff996c8f05f18d220dce1e53',
    edits: [['        onResponse: options?.onResponse,', '        onResponse: options?.onResponse,\n        onProtocolEvent: options?.onProtocolEvent,']],
  },
];
const digest = source => createHash('sha256').update(source).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('SDK 补丁上下文不唯一或已变化。');
  return source.replace(before, () => after);
}

export function patchedSource(source, patch) {
  if (digest(source) !== patch.sha256) {
    // 反向还原后也须匹配完整原始哈希，才能认定是本补丁，支持中断后再运行。
    let original = source;
    for (const [before, after] of [...patch.edits].reverse()) original = replaceOnce(original, after, before);
    if (digest(original) !== patch.sha256) throw new Error(`SDK 源码校验失败：${patch.file}`);
    return source;
  }
  for (const [before, after] of patch.edits) source = replaceOnce(source, before, after);
  return source;
}

export function patchPiResponses(check = false) {
  const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@earendil-works/pi-coding-agent'));
  if (!manifest || JSON.parse(readFileSync(manifest, 'utf8')).version !== '1.5.2') throw new Error('Responses 补丁只支持 pi-ai 1.5.2。');
  const root = join(dirname(manifest), 'dist');
  // 先核对全部文件，未知源码不会留下半套新补丁。
  const changes = patches.map(patch => {
    const path = join(root, patch.file), source = readFileSync(path, 'utf8');
    return { path, source, patched: patchedSource(source, patch) };
  });
  if (check && changes.some(change => change.source !== change.patched)) throw new Error('尚未应用 Responses 补丁，请运行 node scripts/patch-pi-responses.mjs。');
  if (!check) for (const change of changes) if (change.source !== change.patched) writeFileSync(change.path, change.patched);
  return changes.filter(change => change.source !== change.patched).length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = patchPiResponses(process.argv.includes('--check'));
  console.log(`Pi Responses 补丁已核对，修改 ${count} 个文件。`);
}
