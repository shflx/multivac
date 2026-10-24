import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 固定到已核对的 SDK 源码；升级依赖时必须重新审查，不对未知版本做模糊替换。
const patches = [
  {
    file: 'api/openai-responses-shared.js',
    sha256: 'b5d9f001e97bfafa8dfeef2e292f923c39f77fa8aef014132bf3530760f222e3',
    edits: [
      ['    let sawTerminalResponseEvent = false;', '    let sawTerminalResponseEvent = false;\n    const stopAtTerminal = model.api === "openai-responses";'],
      ['    const finalizeResponse = (response) => {', '    const finalizeResponse = (response, eventType) => {'],
      ['    for await (const event of openaiStream) {\n        if (event.type === "response.created") {', `    for await (const event of openaiStream) {
        const terminalStatus = { "response.completed": "completed", "response.incomplete": "incomplete", "response.failed": "failed", "response.cancelled": "cancelled" }[event.type];
        if (stopAtTerminal && terminalStatus && event.response?.status !== terminalStatus) {
            throw new Error("OpenAI Responses terminal event has an invalid status");
        }
        if (event.type === "response.created") {`],
      ['            output.stopReason = "toolUse";\n        }\n    };', `            output.stopReason = "toolUse";
        }
        if (stopAtTerminal && status === "cancelled") output.errorMessage = "Response cancelled by provider";
        // 私有观测只接收枚举；观测异常不得改变协议终结。
        try { options?.onProtocolEvent?.({ type: eventType }); } catch {}
    };`],
      ['        else if (event.type === "response.completed" || event.type === "response.incomplete") {\n            finalizeResponse(event.response);', `        else if (event.type === "response.completed" || event.type === "response.incomplete" || (stopAtTerminal && event.type === "response.cancelled")) {
            finalizeResponse(event.response, event.type);
            // 协议终止不等待 EOF；退出迭代会取消并释放底层响应流。
            if (stopAtTerminal) break;`],
      ['        else if (event.type === "error") {\n            throw new Error', '        else if (event.type === "error") {\n            try { options?.onProtocolEvent?.({ type: "error" }); } catch {}\n            throw new Error'],
      ['        else if (event.type === "response.failed") {\n            sawTerminalResponseEvent = true;\n            output.rawStopReason = event.response?.status;', `        else if (event.type === "response.failed") {
            if (stopAtTerminal) finalizeResponse(event.response, event.type);
            else {
                sawTerminalResponseEvent = true;
                output.rawStopReason = event.response?.status;
            }`],
    ],
  },
  {
    file: 'api/openai-responses.js',
    sha256: '87085aa3c3c865fb51774bc13b669599461fd29e497fc6063bd6f5b9b5262d33',
    edits: [['                serviceTier: options?.serviceTier,\n                grammarToolInputProperties,', '                serviceTier: options?.serviceTier,\n                onProtocolEvent: options?.onProtocolEvent,\n                grammarToolInputProperties,']],
  },
  {
    file: 'api/simple-options.js',
    sha256: '1caf860e028e22639578aba3ec8b79e5be9650c27bd3f19471c78502976555f3',
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
  if (!manifest || JSON.parse(readFileSync(manifest, 'utf8')).version !== '0.85.1') throw new Error('Responses 补丁只支持 pi-ai 0.85.1。');
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
